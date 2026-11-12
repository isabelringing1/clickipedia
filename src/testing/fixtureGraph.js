// Test support: serves the checked-in fixture snapshot through a fake fetch.
//
// The fixture lives in tools/wiki-graph/fixtures/tiny and is produced by the
// Rust builder, so these tests read exactly the bytes a browser would.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = join(here, "..", "..", "tools", "wiki-graph", "fixtures");
export const FIXTURE_PUBLIC_DIR = join(FIXTURES_DIR, "tiny", "public");
export const BASE_URL = "https://graph.test/";

export function readFixtureJson(...parts) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, ...parts), "utf8"));
}

export const expected = readFixtureJson("tiny", "expected.json");
export const titleCases = readFixtureJson("title-cases.json");

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

// Every file under the fixture's public directory, keyed by URL path.
export function readFixtureFiles() {
  const files = new Map();
  for (const path of walk(FIXTURE_PUBLIC_DIR)) {
    const key = relative(FIXTURE_PUBLIC_DIR, path).split(sep).join("/");
    files.set(key, new Uint8Array(readFileSync(path)));
  }
  return files;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// A stand-in for the bucket: an in-memory file tree behind a fetch function
// that records every request and can be told to fail.
export class FakeBucket {
  constructor(files = readFixtureFiles()) {
    this.files = files;
    this.requests = [];
    this.offline = false;
    // Path -> function returning a Response, an Error to throw, or undefined
    // to fall through to the stored file.
    this.overrides = new Map();
    this.fetch = this.fetch.bind(this);
  }

  put(path, bytes) {
    this.files.set(path, typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
  }

  json(path) {
    return JSON.parse(new TextDecoder().decode(this.files.get(path)));
  }

  requestCount(pattern) {
    return this.requests.filter((request) => pattern.test(request.path)).length;
  }

  // Publishes a copy of the fixture snapshot under another ID and points
  // latest.json at it, as a refresh of the graph would.
  promoteCopy(snapshotId) {
    const current = this.json("latest.json");
    const oldRoot = `snapshots/${current.snapshotId}/`;
    const newRoot = `snapshots/${snapshotId}/`;
    for (const [path, bytes] of [...this.files]) {
      if (path.startsWith(oldRoot) && !path.endsWith("manifest.json")) {
        this.files.set(newRoot + path.slice(oldRoot.length), bytes);
      }
    }
    const manifest = { ...this.json(`${oldRoot}manifest.json`), snapshotId };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n");
    this.files.set(`${newRoot}manifest.json`, manifestBytes);
    const latest = {
      schemaVersion: current.schemaVersion,
      snapshotId,
      manifestPath: `${newRoot}manifest.json`,
      manifestSha256: sha256Hex(manifestBytes),
    };
    this.put("latest.json", JSON.stringify(latest, null, 2) + "\n");
    return latest;
  }

  async fetch(url, init = {}) {
    if (!url.startsWith(BASE_URL)) {
      throw new TypeError(`unexpected request to ${url}`);
    }
    const path = url.slice(BASE_URL.length);
    this.requests.push({ path, cache: init.cache });
    if (this.offline) {
      throw new TypeError("Failed to fetch");
    }
    const override = this.overrides.get(path);
    if (override !== undefined) {
      const result = override(init);
      if (result instanceof Error) {
        throw result;
      }
      if (result !== undefined) {
        return result;
      }
    }
    const bytes = this.files.get(path);
    if (bytes === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(bytes.slice(), { status: 200 });
  }
}

// Client options that keep tests fast: no real waiting between retries.
export function fastOptions(bucket, extra = {}) {
  return { fetch: bucket.fetch, sleep: async () => {}, timeoutMs: 0, ...extra };
}
