// End-to-end rehearsal of publish and promote through the real Wrangler CLI,
// against Wrangler's local R2 simulation. It needs no Cloudflare account and
// makes no network requests, but it does start Wrangler several times, so it
// is slower than the other tests.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FIXTURE_PUBLIC_DIR, listSnapshotFiles } from "./lib.mjs";
import { promoteSnapshot, publishSnapshot } from "./publishing.mjs";
import { createWrangler } from "./wrangler.mjs";

const SNAPSHOT = "20260101";
const BUCKET = "rehearsal-bucket";

let root;
let data;
let wrangler;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wiki-graph-rehearsal-"));
  data = join(root, "data");
  cpSync(FIXTURE_PUBLIC_DIR, join(data, "public"), { recursive: true });
  // Keep Wrangler's own log files inside the temporary directory.
  process.env.WRANGLER_LOG_PATH = join(root, "wrangler-logs");
  process.env.WRANGLER_SEND_METRICS = "false";
  wrangler = createWrangler({ persistTo: join(root, "r2") });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("publishing through Wrangler", () => {
  it("reports a missing object as absent", async () => {
    expect(await wrangler.getObject(BUCKET, `snapshots/${SNAPSHOT}/manifest.json`)).toBe(null);
  }, 60_000);

  it("publishes, refuses to overwrite, and promotes", async () => {
    const quiet = { log: () => {}, sleep: async () => {} };
    const published = await publishSnapshot({
      bucket: BUCKET,
      snapshotId: SNAPSHOT,
      data,
      wrangler,
      batchSize: 8,
      ...quiet,
    });
    expect(published.status).toBe("published");

    // Every object is stored byte for byte.
    const snapshotDir = join(data, "public", "snapshots", SNAPSHOT);
    const { files } = listSnapshotFiles(snapshotDir);
    for (const file of [files[0], files[files.length - 2], files[files.length - 1]]) {
      const stored = await wrangler.getObject(BUCKET, `snapshots/${SNAPSHOT}/${file.path}`);
      expect(stored?.equals(readFileSync(join(snapshotDir, file.path))), file.path).toBe(true);
    }
    expect(await wrangler.getObject(BUCKET, "latest.json")).toBe(null);

    // A second run uploads nothing; a different build is refused.
    const again = await publishSnapshot({ bucket: BUCKET, snapshotId: SNAPSHOT, data, wrangler, ...quiet });
    expect(again.status).toBe("already-published");
    const manifestPath = join(snapshotDir, "manifest.json");
    const original = readFileSync(manifestPath);
    writeFileSync(manifestPath, original.toString().replace('"0.1.0"', '"9.9.9"'));
    await expect(
      publishSnapshot({ bucket: BUCKET, snapshotId: SNAPSHOT, data, wrangler, ...quiet }),
    ).rejects.toThrow(/never overwritten/);
    writeFileSync(manifestPath, original);

    let verified = 0;
    const promoted = await promoteSnapshot({
      bucket: BUCKET,
      snapshotId: SNAPSHOT,
      data,
      wrangler,
      verifyPublic: async () => {
        verified += 1;
      },
      log: () => {},
    });
    expect(promoted.status).toBe("promoted");
    expect(verified).toBe(1);
    const latest = await wrangler.getObject(BUCKET, "latest.json");
    expect(latest.toString()).toBe(readFileSync(join(FIXTURE_PUBLIC_DIR, "latest.json"), "utf8"));
  }, 240_000);
});
