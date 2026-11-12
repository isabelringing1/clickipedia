import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FIXTURE_PUBLIC_DIR,
  IMMUTABLE_CACHE_CONTROL,
  LATEST_CACHE_CONTROL,
  UsageError,
  listSnapshotFiles,
  objectHeaders,
  verifyLocalSnapshot,
} from "./lib.mjs";
import { RATE_WINDOW_MS, latestFor, promoteSnapshot, publishSnapshot } from "./publishing.mjs";

const SNAPSHOT = "20260101";
const PREFIX = `snapshots/${SNAPSHOT}/`;
const BUCKET = "test-bucket";

let data;
let snapshotDir;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "wiki-graph-publish-"));
  cpSync(FIXTURE_PUBLIC_DIR, join(data, "public"), { recursive: true });
  snapshotDir = join(data, "public", "snapshots", SNAPSHOT);
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
});

// An in-memory bucket behind the same interface as the Wrangler wrapper.
// It records every call and can be told to fail a given bulk upload.
function fakeWrangler() {
  const objects = new Map();
  const calls = [];
  const wrangler = {
    objects,
    calls,
    failBulkCall: null,
    bulkCalls: 0,
    async getObject(bucket, key) {
      calls.push({ op: "get", bucket, key });
      return objects.get(key)?.bytes ?? null;
    },
    async putObject(bucket, key, file, headers) {
      calls.push({ op: "put", bucket, key });
      objects.set(key, { bytes: readFileSync(file), ...headers });
    },
    async bulkPut(bucket, listFile, headers) {
      wrangler.bulkCalls += 1;
      const entries = JSON.parse(readFileSync(listFile, "utf8"));
      calls.push({ op: "bulk", bucket, keys: entries.map((entry) => entry.key), ...headers });
      if (wrangler.failBulkCall === wrangler.bulkCalls) {
        // Like a real interruption: part of the batch arrives.
        const { key, file } = entries[0];
        objects.set(key, { bytes: readFileSync(file), ...headers });
        throw new UsageError("Wrangler failed to upload a batch (exit code 1).");
      }
      for (const { key, file } of entries) {
        objects.set(key, {
          bytes: readFileSync(file),
          contentType: headers.contentType,
          cacheControl: headers.cacheControl,
        });
      }
    },
  };
  return wrangler;
}

function publish(wrangler, extra = {}) {
  return publishSnapshot({
    bucket: BUCKET,
    snapshotId: SNAPSHOT,
    data,
    wrangler,
    batchSize: 4,
    log: () => {},
    sleep: async () => {},
    ...extra,
  });
}

function uploadedKeys(wrangler) {
  return wrangler.calls.flatMap((call) =>
    call.op === "bulk" ? call.keys : call.op === "put" ? [call.key] : [],
  );
}

describe("objectHeaders", () => {
  it("caches snapshot files forever and the pointer briefly", () => {
    expect(objectHeaders(`${PREFIX}adjacency/000000.bin`)).toEqual({
      contentType: "application/octet-stream",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    });
    expect(objectHeaders(`${PREFIX}manifest.json`)).toEqual({
      contentType: "application/json",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    });
    expect(objectHeaders("latest.json")).toEqual({
      contentType: "application/json",
      cacheControl: LATEST_CACHE_CONTROL,
    });
    expect(IMMUTABLE_CACHE_CONTROL).toContain("immutable");
    expect(LATEST_CACHE_CONTROL).not.toContain("immutable");
  });

  it("refuses keys outside the published layout", () => {
    for (const key of ["other.json", "snapshots/latest.json", "snapshots/x/y.txt", "x.bin", "latest.json.bin"]) {
      expect(() => objectHeaders(key), key).toThrow(UsageError);
    }
  });
});

describe("local verification", () => {
  it("lists exactly the files on disk, manifest last and indexes after shards", () => {
    const { files } = listSnapshotFiles(snapshotDir);
    const paths = files.map((file) => file.path);
    expect(paths.length).toBe(19);
    expect(paths[paths.length - 1]).toBe("manifest.json");
    const firstIndex = paths.findIndex((path) => path.endsWith("/index.bin"));
    const lastShard = paths.findLastIndex((path) => /\/\d{6}\.bin$/.test(path));
    expect(firstIndex).toBeGreaterThan(lastShard);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("accepts the fixture", async () => {
    const listing = await verifyLocalSnapshot(snapshotDir);
    expect(listing.manifest.snapshotId).toBe(SNAPSHOT);
    expect(listing.manifestSha256).toBe(
      JSON.parse(readFileSync(join(data, "public", "latest.json"), "utf8")).manifestSha256,
    );
  });

  it("rejects modified, missing, and unexpected files", async () => {
    const shard = join(snapshotDir, "adjacency", "000001.bin");
    const original = readFileSync(shard);

    const flipped = Buffer.from(original);
    flipped[flipped.length - 1] ^= 1;
    writeFileSync(shard, flipped);
    await expect(verifyLocalSnapshot(snapshotDir)).rejects.toThrow(/SHA-256/);

    writeFileSync(shard, original.subarray(0, original.length - 4));
    await expect(verifyLocalSnapshot(snapshotDir)).rejects.toThrow(/bytes/);

    rmSync(shard);
    await expect(verifyLocalSnapshot(snapshotDir)).rejects.toThrow(/missing/);

    writeFileSync(shard, original);
    writeFileSync(join(snapshotDir, "adjacency", "stray.bin"), "x");
    await expect(verifyLocalSnapshot(snapshotDir)).rejects.toThrow(/does not describe/);
  });
});

describe("publishSnapshot", () => {
  it("uploads every file once with the right headers, manifest last", async () => {
    const wrangler = fakeWrangler();
    const result = await publish(wrangler);
    expect(result.status).toBe("published");
    expect(result.uploaded).toBe(19);

    const keys = uploadedKeys(wrangler);
    expect(keys.length).toBe(19);
    expect(new Set(keys).size).toBe(19);
    expect(keys[keys.length - 1]).toBe(`${PREFIX}manifest.json`);
    // Indexes are uploaded only after every shard and report.
    const firstIndex = keys.findIndex((key) => key.endsWith("/index.bin"));
    expect(keys.slice(0, firstIndex).some((key) => key.endsWith("/index.bin"))).toBe(false);
    expect(keys.slice(firstIndex, -1).every((key) => key.endsWith("/index.bin"))).toBe(true);

    for (const [key, object] of wrangler.objects) {
      expect(key.startsWith(PREFIX), key).toBe(true);
      expect({ contentType: object.contentType, cacheControl: object.cacheControl }).toEqual(
        objectHeaders(key),
      );
      expect(object.bytes.equals(readFileSync(join(data, "public", key)))).toBe(true);
    }
  });

  it("never uploads latest.json", async () => {
    const wrangler = fakeWrangler();
    await publish(wrangler);
    expect(wrangler.objects.has("latest.json")).toBe(false);
  });

  it("respects the batch size and one content type per batch", async () => {
    const wrangler = fakeWrangler();
    await publish(wrangler, { batchSize: 3 });
    for (const call of wrangler.calls.filter((entry) => entry.op === "bulk")) {
      expect(call.keys.length).toBeLessThanOrEqual(3);
      const types = new Set(call.keys.map((key) => objectHeaders(key).contentType));
      expect([...types]).toEqual([call.contentType]);
      expect(call.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
    }
  });

  it("uploads nothing unless the local snapshot matches its manifest", async () => {
    const wrangler = fakeWrangler();
    const shard = join(snapshotDir, "titles", "000002.bin");
    const bytes = readFileSync(shard);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(shard, bytes);
    await expect(publish(wrangler)).rejects.toThrow(UsageError);
    expect(wrangler.calls).toEqual([]);
  });

  it("does nothing when the same build is already published", async () => {
    const wrangler = fakeWrangler();
    await publish(wrangler);
    wrangler.calls.length = 0;
    const result = await publish(wrangler);
    expect(result.status).toBe("already-published");
    expect(uploadedKeys(wrangler)).toEqual([]);
  });

  it("refuses to overwrite a published snapshot with different contents", async () => {
    const wrangler = fakeWrangler();
    await publish(wrangler);
    const before = new Map(wrangler.objects);
    wrangler.calls.length = 0;

    // A rebuild under the same ID whose manifest differs.
    const manifestPath = join(snapshotDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.generator.version = "9.9.9";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(publish(wrangler)).rejects.toThrow(/never overwritten/);
    expect(uploadedKeys(wrangler)).toEqual([]);
    expect(wrangler.objects).toEqual(before);
  });

  it("resumes an interrupted upload without repeating finished batches", async () => {
    const wrangler = fakeWrangler();
    wrangler.failBulkCall = 3;
    await expect(publish(wrangler)).rejects.toThrow(/failed to upload/);
    // Readers cannot see the partial snapshot: no manifest yet.
    expect(wrangler.objects.has(`${PREFIX}manifest.json`)).toBe(false);
    const finishedFirst = wrangler.calls
      .filter((call) => call.op === "bulk")
      .slice(0, 2)
      .flatMap((call) => call.keys);
    expect(finishedFirst.length).toBe(8);

    wrangler.failBulkCall = null;
    wrangler.calls.length = 0;
    const result = await publish(wrangler);
    expect(result.status).toBe("published");
    const second = uploadedKeys(wrangler);
    expect(second.some((key) => finishedFirst.includes(key))).toBe(false);
    expect(second.length).toBe(19 - 8);
    expect(wrangler.objects.size).toBe(19);
    for (const [key, object] of wrangler.objects) {
      expect(object.bytes.equals(readFileSync(join(data, "public", key))), key).toBe(true);
    }
  });

  it("refuses to mix a different build into a partly uploaded prefix", async () => {
    const wrangler = fakeWrangler();
    wrangler.failBulkCall = 2;
    await expect(publish(wrangler)).rejects.toThrow(/failed to upload/);

    const manifestPath = join(snapshotDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.generator.version = "9.9.9";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    wrangler.failBulkCall = null;
    wrangler.calls.length = 0;
    await expect(publish(wrangler)).rejects.toThrow(/different build/);
    expect(uploadedKeys(wrangler)).toEqual([]);
  });

  it("does not treat a failed existence check as an empty bucket", async () => {
    const wrangler = fakeWrangler();
    wrangler.getObject = async () => {
      throw new UsageError("Wrangler could not read the bucket");
    };
    await expect(publish(wrangler)).rejects.toThrow(/could not read/);
    expect(uploadedKeys(wrangler)).toEqual([]);
  });

  it("uploads nothing in a dry run", async () => {
    const wrangler = fakeWrangler();
    const result = await publish(wrangler, { dryRun: true });
    expect(result).toMatchObject({ status: "dry-run", pending: 19 });
    expect(uploadedKeys(wrangler)).toEqual([]);
    expect(existsSync(join(data, "publish"))).toBe(false);
  });

  it("stays under the API rate limit", async () => {
    const wrangler = fakeWrangler();
    let clock = 0;
    const waits = [];
    await publish(wrangler, {
      batchSize: 4,
      rate: 8,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    // 19 objects at 8 per window need three windows, so two waits.
    expect(waits).toEqual([RATE_WINDOW_MS, RATE_WINDOW_MS]);
    expect(wrangler.objects.size).toBe(19);
  });

  it("requires a bucket and sane limits", async () => {
    const wrangler = fakeWrangler();
    await expect(publish(wrangler, { bucket: undefined })).rejects.toThrow(/bucket/);
    await expect(publish(wrangler, { rate: 2, batchSize: 4 })).rejects.toThrow(UsageError);
    await expect(publish(wrangler, { snapshotId: "../x" })).rejects.toThrow(UsageError);
  });

  it("leaves no batch list file behind", async () => {
    const wrangler = fakeWrangler();
    await publish(wrangler);
    expect(readdirSync(join(data, "publish", BUCKET))).toEqual([`${SNAPSHOT}.json`]);
  });
});

describe("promoteSnapshot", () => {
  function promote(wrangler, extra = {}) {
    return promoteSnapshot({
      bucket: BUCKET,
      snapshotId: SNAPSHOT,
      data,
      wrangler,
      verifyPublic: async () => {},
      log: () => {},
      ...extra,
    });
  }

  it("writes the same pointer the Rust tool writes", () => {
    const manifestBytes = readFileSync(join(snapshotDir, "manifest.json"));
    const bytes = `${JSON.stringify(latestFor(SNAPSHOT, manifestBytes), null, 2)}\n`;
    expect(bytes).toBe(readFileSync(join(FIXTURE_PUBLIC_DIR, "latest.json"), "utf8"));
  });

  it("uploads latest.json with a short cache lifetime after verification", async () => {
    const wrangler = fakeWrangler();
    await publish(wrangler);
    const order = [];
    const result = await promote(wrangler, {
      verifyPublic: async (options) => {
        order.push(`verify ${options.snapshotId}`);
        expect(wrangler.objects.has("latest.json")).toBe(false);
      },
    });
    expect(result.status).toBe("promoted");
    expect(order).toEqual([`verify ${SNAPSHOT}`]);
    const latest = wrangler.objects.get("latest.json");
    expect(latest.cacheControl).toBe(LATEST_CACHE_CONTROL);
    expect(latest.contentType).toBe("application/json");
    expect(latest.bytes.toString()).toBe(
      readFileSync(join(FIXTURE_PUBLIC_DIR, "latest.json"), "utf8"),
    );
  });

  it("does not promote when public verification fails", async () => {
    const wrangler = fakeWrangler();
    await publish(wrangler);
    await expect(
      promote(wrangler, {
        verifyPublic: async () => {
          throw new UsageError("Public verification failed");
        },
      }),
    ).rejects.toThrow(/verification failed/);
    expect(wrangler.objects.has("latest.json")).toBe(false);
  });

  it("does not promote a snapshot that is not published", async () => {
    const wrangler = fakeWrangler();
    await expect(promote(wrangler)).rejects.toThrow(/not published/);
    expect(wrangler.objects.size).toBe(0);
  });

  it("does not promote when the published manifest is not the local build", async () => {
    const wrangler = fakeWrangler();
    await publish(wrangler);
    wrangler.objects.get(`${PREFIX}manifest.json`).bytes = Buffer.from("{}");
    await expect(promote(wrangler)).rejects.toThrow(/differs from the local build/);
    expect(wrangler.objects.has("latest.json")).toBe(false);
  });

  it("is a no-op when latest.json already points at the snapshot", async () => {
    const wrangler = fakeWrangler();
    await publish(wrangler);
    await promote(wrangler);
    wrangler.calls.length = 0;
    const result = await promote(wrangler, {
      verifyPublic: async () => {
        throw new Error("should not be called");
      },
    });
    expect(result.status).toBe("unchanged");
    expect(wrangler.calls.some((call) => call.op === "put")).toBe(false);
  });

  it("reports the previous snapshot so it can be rolled back to", async () => {
    const wrangler = fakeWrangler();
    await publish(wrangler);
    wrangler.objects.set("latest.json", {
      bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, snapshotId: "20251201" })),
    });
    const result = await promote(wrangler);
    expect(result.status).toBe("promoted");
    expect(result.previous.snapshotId).toBe("20251201");
    expect(JSON.parse(wrangler.objects.get("latest.json").bytes).snapshotId).toBe(SNAPSHOT);
  });
});
