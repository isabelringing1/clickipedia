// Uploads a built snapshot to R2 and, separately, promotes it.
//
// Rules this file enforces:
//
//   * Only what the manifest describes is uploaded, after every local file
//     has been checked against the manifest's lengths and hashes.
//   * A published snapshot is never overwritten. A snapshot counts as
//     published once its manifest.json exists in the bucket, and the manifest
//     is uploaded last, so readers never see a partial snapshot.
//   * An interrupted upload resumes from a local journal. The journal records
//     which build it belongs to; a different build under the same ID is
//     refused rather than mixed into the same prefix.
//   * latest.json is written only by promoteSnapshot, never by an upload.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  LATEST_KEY,
  UsageError,
  formatBytes,
  objectHeaders,
  publicDir,
  sha256Hex,
  snapshotPrefix,
  verifyLocalSnapshot,
} from "./lib.mjs";

// Cloudflare's API allows about 1,200 requests per five minutes per user.
export const RATE_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_RATE = 1000;
export const DEFAULT_BATCH_SIZE = 200;
export const DEFAULT_CONCURRENCY = 16;

function journalPath(data, bucket, snapshotId) {
  return join(data, "publish", bucket, `${snapshotId}.json`);
}

function loadJournal(path) {
  if (!existsSync(path)) {
    return null;
  }
  const journal = JSON.parse(readFileSync(path, "utf8"));
  return { ...journal, uploaded: new Set(journal.uploaded) };
}

function saveJournal(path, journal) {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...journal, uploaded: [...journal.uploaded] }));
  renameSync(temporary, path);
}

// Keeps uploads under `rate` objects per rolling window.
function createPacer({ rate, now, sleep, log }) {
  const sent = [];
  return async function pace(count) {
    for (;;) {
      const cutoff = now() - RATE_WINDOW_MS;
      while (sent.length > 0 && sent[0].at <= cutoff) {
        sent.shift();
      }
      const used = sent.reduce((total, entry) => total + entry.count, 0);
      if (used + count <= rate || sent.length === 0) {
        sent.push({ at: now(), count });
        return;
      }
      const wait = sent[0].at + RATE_WINDOW_MS - now();
      log(`  waiting ${Math.ceil(wait / 1000)}s to stay under the API rate limit`);
      await sleep(wait);
    }
  };
}

function batches(files, size) {
  const out = [];
  for (let i = 0; i < files.length; i += size) {
    out.push(files.slice(i, i + size));
  }
  return out;
}

// Splits files into upload stages. Within the snapshot, indexes go after the
// shards they describe; the manifest is handled separately, last of all.
function planStages(files) {
  const isIndex = (file) => file.path.endsWith("/index.bin");
  const body = files.filter((file) => file.path !== "manifest.json" && !isIndex(file));
  const indexes = files.filter(isIndex);
  return [body, indexes];
}

export async function publishSnapshot({
  bucket,
  snapshotId,
  data,
  wrangler,
  rate = DEFAULT_RATE,
  batchSize = DEFAULT_BATCH_SIZE,
  concurrency = DEFAULT_CONCURRENCY,
  dryRun = false,
  log = console.log,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!bucket) {
    throw new UsageError("No bucket given. Pass --bucket or set WIKI_GRAPH_R2_BUCKET.");
  }
  if (!(rate >= 1) || !(batchSize >= 1) || batchSize > rate) {
    throw new UsageError("--rate and --batch must be positive, and a batch must fit in the rate.");
  }
  const prefix = snapshotPrefix(snapshotId);
  const snapshotDir = join(publicDir(data), "snapshots", snapshotId);

  log(`Checking ${snapshotDir} against its manifest`);
  const listing = await verifyLocalSnapshot(snapshotDir);
  const totalBytes = listing.files.reduce((total, file) => total + file.bytes, 0);
  log(`  ${listing.files.length} files, ${formatBytes(totalBytes)}, manifest ${listing.manifestSha256}`);

  const manifestKey = `${prefix}manifest.json`;
  const remoteManifest = await wrangler.getObject(bucket, manifestKey);
  if (remoteManifest !== null) {
    if (Buffer.compare(remoteManifest, listing.manifestBytes) === 0) {
      log(`Snapshot ${snapshotId} is already published in ${bucket}; nothing to upload.`);
      return { status: "already-published", uploaded: 0, manifestSha256: listing.manifestSha256 };
    }
    throw new UsageError(
      `Snapshot ${snapshotId} is already published in ${bucket} with different contents ` +
        `(remote manifest ${sha256Hex(remoteManifest)}). Published snapshots are never ` +
        "overwritten: rebuild under a new ID with `build --snapshot-id`.",
    );
  }

  const journalFile = journalPath(data, bucket, snapshotId);
  let journal = loadJournal(journalFile);
  if (journal !== null && journal.manifestSha256 !== listing.manifestSha256) {
    throw new UsageError(
      `An earlier upload of a different build of ${snapshotId} to ${bucket} was started but not ` +
        `finished (${journal.uploaded.size} objects, manifest ${journal.manifestSha256}). Mixing ` +
        "two builds under one ID would corrupt it: rebuild under a new ID with `build --snapshot-id`.",
    );
  }
  journal ??= { bucket, snapshotId, manifestSha256: listing.manifestSha256, uploaded: new Set() };

  const pending = listing.files.filter((file) => !journal.uploaded.has(prefix + file.path));
  const resumed = listing.files.length - pending.length;
  if (resumed > 0) {
    log(`Resuming: ${resumed} objects were uploaded earlier`);
  }
  if (dryRun) {
    log(`Dry run: would upload ${pending.length} objects to ${bucket}/${prefix}`);
    return { status: "dry-run", uploaded: 0, pending: pending.length, manifestSha256: listing.manifestSha256 };
  }

  const pace = createPacer({ rate, now, sleep, log });
  const listFile = join(data, "publish", bucket, `${snapshotId}.batch.json`);
  mkdirSync(join(listFile, ".."), { recursive: true });
  let uploaded = 0;
  const remaining = pending.filter((file) => file.path !== "manifest.json").length;

  try {
    for (const stage of planStages(pending)) {
      // Wrangler applies one content type per batch.
      const byType = new Map();
      for (const file of stage) {
        const { contentType } = objectHeaders(prefix + file.path);
        byType.set(contentType, [...(byType.get(contentType) ?? []), file]);
      }
      for (const [contentType, files] of byType) {
        for (const batch of batches(files, batchSize)) {
          await pace(batch.length);
          writeFileSync(
            listFile,
            JSON.stringify(
              batch.map((file) => ({ key: prefix + file.path, file: join(snapshotDir, file.path) })),
            ),
          );
          await wrangler.bulkPut(bucket, listFile, {
            contentType,
            cacheControl: objectHeaders(prefix + batch[0].path).cacheControl,
            concurrency,
          });
          for (const file of batch) {
            journal.uploaded.add(prefix + file.path);
          }
          saveJournal(journalFile, journal);
          uploaded += batch.length;
          log(`  uploaded ${uploaded} of ${remaining} objects`);
        }
      }
    }
  } finally {
    rmSync(listFile, { force: true });
  }

  // Everything the manifest refers to is in place; publishing the manifest
  // is what makes the snapshot exist for readers.
  const missing = listing.files.filter(
    (file) => file.path !== "manifest.json" && !journal.uploaded.has(prefix + file.path),
  );
  if (missing.length > 0) {
    throw new Error(`internal error: ${missing.length} objects were not uploaded`);
  }
  await pace(1);
  await wrangler.putObject(
    bucket,
    manifestKey,
    join(snapshotDir, "manifest.json"),
    objectHeaders(manifestKey),
  );
  journal.uploaded.add(manifestKey);
  saveJournal(journalFile, journal);
  log(`Published snapshot ${snapshotId} to ${bucket}. latest.json is unchanged.`);
  return { status: "published", uploaded: uploaded + 1, manifestSha256: listing.manifestSha256 };
}

// Builds the pointer for a snapshot from its local manifest.
export function latestFor(snapshotId, manifestBytes) {
  return {
    schemaVersion: 1,
    snapshotId,
    manifestPath: `${snapshotPrefix(snapshotId)}manifest.json`,
    manifestSha256: sha256Hex(manifestBytes),
  };
}

// Points latest.json at a published snapshot. New games start on it; saves
// that already exist stay on the snapshot they were started with.
//
// `verifyPublic` must check the snapshot as browsers will fetch it and throw
// if anything is wrong; promotion does not happen without it.
export async function promoteSnapshot({
  bucket,
  snapshotId,
  data,
  wrangler,
  verifyPublic,
  log = console.log,
}) {
  if (!bucket) {
    throw new UsageError("No bucket given. Pass --bucket or set WIKI_GRAPH_R2_BUCKET.");
  }
  const prefix = snapshotPrefix(snapshotId);
  const manifestPath = join(publicDir(data), "snapshots", snapshotId, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new UsageError(`${manifestPath} does not exist. Promote from the machine that built it.`);
  }
  const manifestBytes = readFileSync(manifestPath);

  const remoteManifest = await wrangler.getObject(bucket, `${prefix}manifest.json`);
  if (remoteManifest === null) {
    throw new UsageError(`Snapshot ${snapshotId} is not published in ${bucket}. Run the publish step first.`);
  }
  if (Buffer.compare(remoteManifest, manifestBytes) !== 0) {
    throw new UsageError(
      `The manifest of ${snapshotId} in ${bucket} differs from the local build. ` +
        "Promote only the build that was published.",
    );
  }

  const latest = latestFor(snapshotId, manifestBytes);
  const latestBytes = Buffer.from(`${JSON.stringify(latest, null, 2)}\n`);

  const previousBytes = await wrangler.getObject(bucket, LATEST_KEY);
  let previous = null;
  if (previousBytes !== null) {
    try {
      previous = JSON.parse(previousBytes.toString("utf8"));
    } catch {
      previous = null;
    }
    if (Buffer.compare(previousBytes, latestBytes) === 0) {
      log(`latest.json already points at ${snapshotId}.`);
      return { status: "unchanged", latest, previous };
    }
  }

  log(`Verifying snapshot ${snapshotId} at its public URL before promoting`);
  await verifyPublic({ snapshotId, manifestSha256: latest.manifestSha256 });

  const latestFile = join(data, "publish", bucket, LATEST_KEY);
  mkdirSync(join(latestFile, ".."), { recursive: true });
  writeFileSync(latestFile, latestBytes);
  await wrangler.putObject(bucket, LATEST_KEY, latestFile, objectHeaders(LATEST_KEY));

  const confirmed = await wrangler.getObject(bucket, LATEST_KEY);
  if (confirmed === null || Buffer.compare(confirmed, latestBytes) !== 0) {
    throw new Error("latest.json in the bucket does not match what was uploaded");
  }
  log(
    `Promoted ${snapshotId}.` +
      (previous?.snapshotId
        ? ` To roll back, promote ${previous.snapshotId} again; it is still published.`
        : ""),
  );
  return { status: "promoted", latest, previous };
}
