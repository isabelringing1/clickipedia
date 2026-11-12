import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CORS_POLICY_FILE, defaultOrigins, parseExpectedLinks } from "./cli.mjs";
import { FIXTURE_PUBLIC_DIR, REPO_DIR, UsageError, sha256Hex } from "./lib.mjs";
import { verifyPublicSnapshot } from "./publicCheck.mjs";
import { createGraphServer } from "./serve.mjs";

const SNAPSHOT = "20260101";
const GAME = "https://isabisabel.com";
const LOCAL = "http://localhost:5173";
const MANIFEST_SHA256 = sha256Hex(
  readFileSync(join(FIXTURE_PUBLIC_DIR, "snapshots", SNAPSHOT, "manifest.json")),
);

let servers = [];
let directories = [];

function listen(options) {
  const server = createGraphServer({ dir: FIXTURE_PUBLIC_DIR, allowedOrigins: [GAME], ...options });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/`));
  });
}

function fixtureCopy() {
  const dir = mkdtempSync(join(tmpdir(), "wiki-graph-public-"));
  directories.push(dir);
  cpSync(FIXTURE_PUBLIC_DIR, dir, { recursive: true });
  return dir;
}

function verify(baseUrl, extra = {}) {
  return verifyPublicSnapshot({
    baseUrl,
    snapshotId: SNAPSHOT,
    manifestSha256: MANIFEST_SHA256,
    origins: [GAME, LOCAL],
    log: () => {},
    ...extra,
  });
}

// Rewrites response headers, to imitate a misconfigured bucket or CDN.
function withHeaders(change) {
  return async (url, init) => {
    const response = await fetch(url, init);
    const headers = new Headers(response.headers);
    change(headers, url, init);
    return new Response(await response.arrayBuffer(), { status: response.status, headers });
  };
}

beforeEach(() => {
  servers = [];
  directories = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("verifyPublicSnapshot", () => {
  it("accepts a correctly served snapshot, including latest.json", async () => {
    const baseUrl = await listen();
    const stats = await verify(baseUrl, {
      expectLatest: true,
      all: true,
      expectLinks: [
        ["Incremental game", "Cookie Clicker"],
        ["Idle game", "Café"],
      ],
    });
    // Manifest, 3 indexes, 11 shards, the report, CORS probes, latest.json.
    expect(stats.requests).toBeGreaterThanOrEqual(16);
  });

  it("samples shards when asked to, always including the last one", async () => {
    const baseUrl = await listen();
    const requested = [];
    await verify(baseUrl, {
      samples: 2,
      fetch: (url, init) => {
        requested.push(url.slice(baseUrl.length));
        return fetch(url, init);
      },
    });
    expect(requested).toContain(`snapshots/${SNAPSHOT}/metadata/000000.bin`);
    expect(requested).toContain(`snapshots/${SNAPSHOT}/metadata/000003.bin`);
    expect(requested).not.toContain(`snapshots/${SNAPSHOT}/metadata/000002.bin`);
  });

  it("reports a link that is missing from the graph", async () => {
    const baseUrl = await listen();
    await expect(
      verify(baseUrl, { expectLinks: [["Dead end", "Incremental game"]] }),
    ).rejects.toThrow(/Dead end -> Incremental game is not in the graph/);
    await expect(
      verify(baseUrl, { expectLinks: [["Incremental game", "Nonexistent page"]] }),
    ).rejects.toThrow(/Nonexistent page is not an article/);
  });

  it("rejects a manifest that is not the build that was verified locally", async () => {
    const baseUrl = await listen();
    await expect(verify(baseUrl, { manifestSha256: "0".repeat(64) })).rejects.toThrow(
      /does not match its pinned SHA-256/,
    );
  });

  it("rejects a corrupted shard", async () => {
    const dir = fixtureCopy();
    const shard = join(dir, "snapshots", SNAPSHOT, "titles", "000003.bin");
    const bytes = readFileSync(shard);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(shard, bytes);
    const baseUrl = await listen({ dir });
    await expect(verify(baseUrl, { all: true })).rejects.toThrow(/titles\/000003\.bin does not match/);
  });

  it("rejects a snapshot with a missing object", async () => {
    const dir = fixtureCopy();
    rmSync(join(dir, "snapshots", SNAPSHOT, "adjacency", "000002.bin"));
    const baseUrl = await listen({ dir });
    await expect(verify(baseUrl, { all: true })).rejects.toThrow(/HTTP 404/);
  });

  it("rejects snapshot files that are not cached immutably", async () => {
    const baseUrl = await listen({ noStore: true });
    await expect(verify(baseUrl)).rejects.toThrow(/Cache-Control "no-store"/);
  });

  it("rejects a wrong content type", async () => {
    const baseUrl = await listen();
    const fetchWrongType = withHeaders((headers, url) => {
      if (url.endsWith(".bin")) {
        headers.set("content-type", "text/plain");
      }
    });
    await expect(verify(baseUrl, { fetch: fetchWrongType })).rejects.toThrow(
      /Content-Type "text\/plain"/,
    );
  });

  it("rejects a bucket that does not allow the game's origin", async () => {
    const baseUrl = await listen({ allowedOrigins: [] });
    await expect(verify(baseUrl)).rejects.toThrow(
      /requested from https:\/\/isabisabel\.com got Access-Control-Allow-Origin "\(none\)"/,
    );
  });

  it("rejects a bucket readable from any origin unless that is intended", async () => {
    const baseUrl = await listen();
    const fetchOpen = withHeaders((headers) => headers.set("access-control-allow-origin", "*"));
    await expect(verify(baseUrl, { fetch: fetchOpen })).rejects.toThrow(/readable from any origin/);
    await verify(baseUrl, { fetch: fetchOpen, allowAnyOrigin: true });
  });

  it("rejects a cache that replays one origin's CORS header to another", async () => {
    const baseUrl = await listen();
    // A CDN that ignores `Vary: Origin` answers everyone with the first
    // origin it saw.
    const fetchStale = withHeaders((headers) => headers.set("access-control-allow-origin", GAME));
    await expect(verify(baseUrl, { fetch: fetchStale })).rejects.toThrow(
      /requested from http:\/\/localhost:5173 got Access-Control-Allow-Origin "https:\/\/isabisabel\.com"/,
    );
  });

  it("rejects a latest.json that points at another snapshot", async () => {
    const dir = fixtureCopy();
    const latestPath = join(dir, "latest.json");
    const latest = JSON.parse(readFileSync(latestPath, "utf8"));
    writeFileSync(
      latestPath,
      JSON.stringify({
        ...latest,
        snapshotId: "20251201",
        manifestPath: "snapshots/20251201/manifest.json",
      }),
    );
    const baseUrl = await listen({ dir });
    await expect(verify(baseUrl, { expectLatest: true })).rejects.toThrow(
      /latest\.json points at 20251201, expected 20260101/,
    );
    // Without the latest check (before promotion) the snapshot itself passes.
    await verify(baseUrl);
  });

  it("rejects a latest.json that is cached for too long", async () => {
    const baseUrl = await listen();
    const fetchLongLived = withHeaders((headers, url) => {
      if (url.endsWith("latest.json")) {
        headers.set("cache-control", "public, max-age=31536000, immutable");
      }
    });
    await expect(verify(baseUrl, { fetch: fetchLongLived, expectLatest: true })).rejects.toThrow(
      /latest\.json has Cache-Control/,
    );
  });

  it("reports an unreachable address as a failure, not a crash", async () => {
    const baseUrl = await listen();
    const fetchDown = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(verify(baseUrl, { fetch: fetchDown })).rejects.toThrow(UsageError);
  });

  it("needs an origin to test CORS with", async () => {
    const baseUrl = await listen();
    await expect(verify(baseUrl, { origins: [] })).rejects.toThrow(/--origin/);
  });
});

describe("the local graph server", () => {
  it("serves only files in the published layout", async () => {
    const baseUrl = await listen();
    for (const path of [
      "",
      "../package.json",
      "snapshots/../../expected.json",
      "%2e%2e/expected.json",
      "snapshots/20260101/",
      "snapshots/20260101/nope.bin",
      "latest.txt",
    ]) {
      const response = await fetch(baseUrl + path);
      expect(response.status, path).toBe(404);
    }
  });

  it("allows localhost on any port and listed origins only", async () => {
    const baseUrl = await listen();
    const allowOrigin = async (origin) => {
      const response = await fetch(`${baseUrl}latest.json`, { headers: { Origin: origin } });
      return response.headers.get("access-control-allow-origin");
    };
    expect(await allowOrigin("http://localhost:4173")).toBe("http://localhost:4173");
    expect(await allowOrigin(GAME)).toBe(GAME);
    expect(await allowOrigin("https://example.com")).toBe(null);
    expect(await allowOrigin("http://localhost.example.com")).toBe(null);
  });

  it("answers HEAD and refuses writes", async () => {
    const baseUrl = await listen();
    const head = await fetch(`${baseUrl}latest.json`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    const put = await fetch(`${baseUrl}latest.json`, { method: "PUT", body: "{}" });
    expect(put.status).toBe(405);
  });
});

describe("command-line helpers", () => {
  it("checks the origins of the bucket's CORS policy by default", () => {
    // R2 matches origins exactly, so localhost and 127.0.0.1 are both listed
    // for the Vite dev (5173) and preview (4173) servers.
    expect(defaultOrigins()).toEqual([
      GAME,
      LOCAL,
      "http://127.0.0.1:5173",
      "http://localhost:4173",
      "http://127.0.0.1:4173",
    ]);
  });

  it("allows the origin the game is deployed to", () => {
    const { homepage } = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf8"));
    expect(defaultOrigins()).toContain(new URL(homepage).origin);
  });

  it("only allows reading in the CORS policy", () => {
    const policy = JSON.parse(readFileSync(CORS_POLICY_FILE, "utf8"));
    for (const rule of policy.rules) {
      expect(rule.allowed.methods).toEqual(["GET"]);
      expect(rule.allowed.origins).not.toContain("*");
    }
  });

  it("parses expected links", () => {
    expect(parseExpectedLinks(["Incremental game | Cookie Clicker"])).toEqual([
      ["Incremental game", "Cookie Clicker"],
    ]);
    expect(() => parseExpectedLinks(["Incremental game"])).toThrow(UsageError);
    expect(() => parseExpectedLinks(["a|"])).toThrow(UsageError);
  });
});
