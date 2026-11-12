// Shared helpers for the publishing scripts.
//
// The object layout in the bucket mirrors data/public on disk:
//
//   latest.json                       mutable pointer, short cache
//   snapshots/<id>/manifest.json      immutable
//   snapshots/<id>/<kind>/NNNNNN.bin  immutable

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeShardIndex, shardPath } from "../../../src/wikiGraph/codec.js";
import { validateManifest } from "../../../src/wikiGraph/client.js";

export const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
export const TOOL_DIR = resolve(SCRIPTS_DIR, "..");
export const REPO_DIR = resolve(TOOL_DIR, "..", "..");
export const FIXTURE_PUBLIC_DIR = join(TOOL_DIR, "fixtures", "tiny", "public");

export const LATEST_KEY = "latest.json";
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const LATEST_CACHE_CONTROL = "public, max-age=60, must-revalidate";

const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// A problem the operator can act on; printed without a stack trace.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

// Same default as the Rust tool, including the WIKI_GRAPH_DATA_DIR override.
export function dataDir(explicit) {
  return resolve(explicit ?? process.env.WIKI_GRAPH_DATA_DIR ?? join(TOOL_DIR, "data.nosync"));
}

export function publicDir(data) {
  return join(data, "public");
}

export function checkSnapshotId(snapshotId) {
  if (typeof snapshotId !== "string" || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new UsageError(`"${snapshotId}" is not a valid snapshot ID.`);
  }
  return snapshotId;
}

export function snapshotPrefix(snapshotId) {
  return `snapshots/${checkSnapshotId(snapshotId)}/`;
}

// The HTTP metadata every object is uploaded with. Snapshot files never
// change, so they are cached for a year; the pointer must be revalidated.
export function objectHeaders(key) {
  let contentType;
  if (key.endsWith(".json")) {
    contentType = "application/json";
  } else if (key.endsWith(".bin")) {
    contentType = "application/octet-stream";
  } else {
    throw new UsageError(`No content type is defined for "${key}".`);
  }
  if (key === LATEST_KEY) {
    return { contentType, cacheControl: LATEST_CACHE_CONTROL };
  }
  if (/^snapshots\/[A-Za-z0-9_-]{1,64}\/.+/.test(key)) {
    return { contentType, cacheControl: IMMUTABLE_CACHE_CONTROL };
  }
  throw new UsageError(`"${key}" is not part of the published layout.`);
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else {
      out.push(path);
    }
  }
  return out;
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

// Lists every file the manifest says the snapshot consists of, in upload
// order: shards and reports, then the per-kind indexes, then the manifest.
// A reader can only find a file through the ones after it in this order, so
// an interrupted upload never exposes a snapshot with missing pieces.
export function listSnapshotFiles(snapshotDir) {
  const manifestPath = join(snapshotDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new UsageError(`${snapshotDir} has no manifest.json. Build the snapshot first.`);
  }
  const manifestBytes = readFileSync(manifestPath);
  const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")));

  const shards = [];
  const indexes = [];
  for (const kind of ["adjacency", "metadata", "titles"]) {
    const section = manifest[kind];
    const index = decodeShardIndex(readFileSync(join(snapshotDir, section.index.path)));
    const count = kind === "titles" ? section.bucketCount : section.shardCount;
    if (index.count !== count) {
      throw new UsageError(`${section.index.path} lists ${index.count} shards, expected ${count}.`);
    }
    for (let i = 0; i < count; i += 1) {
      const entry = index.entry(i);
      shards.push({ path: shardPath(section.dir, i), bytes: entry.bytes, sha256: hex(entry.sha256) });
    }
    indexes.push({ ...section.index });
  }
  const reports = Object.values(manifest.reports ?? {}).map((ref) => ({ ...ref }));
  const manifestFile = {
    path: "manifest.json",
    bytes: manifestBytes.length,
    sha256: sha256Hex(manifestBytes),
  };

  return {
    manifest,
    manifestBytes,
    manifestSha256: manifestFile.sha256,
    files: [...shards, ...reports, ...indexes, manifestFile],
  };
}

// Checks that the directory holds exactly the files the manifest describes,
// byte for byte. Nothing is uploaded unless this passes.
export async function verifyLocalSnapshot(snapshotDir, { onProgress = () => {} } = {}) {
  const listing = listSnapshotFiles(snapshotDir);
  const expected = new Set(listing.files.map((file) => file.path));
  const present = walk(snapshotDir).map((path) => relative(snapshotDir, path).split(sep).join("/"));
  const extra = present.filter((path) => !expected.has(path));
  if (extra.length > 0) {
    throw new UsageError(
      `${snapshotDir} contains files the manifest does not describe: ${extra.slice(0, 5).join(", ")}` +
        (extra.length > 5 ? ` and ${extra.length - 5} more` : ""),
    );
  }

  let done = 0;
  for (const file of listing.files) {
    const path = join(snapshotDir, file.path);
    if (!existsSync(path)) {
      throw new UsageError(`${file.path} is missing from ${snapshotDir}.`);
    }
    const size = statSync(path).size;
    if (size !== file.bytes) {
      throw new UsageError(`${file.path} is ${size} bytes, the manifest expects ${file.bytes}.`);
    }
    if ((await sha256File(path)) !== file.sha256) {
      throw new UsageError(`${file.path} does not match the SHA-256 recorded for it.`);
    }
    done += 1;
    onProgress(done, listing.files.length);
  }
  return listing;
}

export function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(2)} ${units[unit]}`;
}

// Runs a script's main function, printing operator errors plainly.
export async function runMain(main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  }
}
