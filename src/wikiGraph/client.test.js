import { beforeEach, describe, expect, it } from "vitest";

import { BASE_URL, FakeBucket, expected, fastOptions } from "../testing/fixtureGraph.js";
import {
  GraphClient,
  GraphError,
  fetchManifest,
  loadLatest,
  normalizeBaseUrl,
  openSnapshot,
  snapshotRoot,
  validateManifest,
} from "./client.js";

const ROOT = `snapshots/${expected.snapshotId}/`;

let bucket;

beforeEach(() => {
  bucket = new FakeBucket();
});

async function open(extra) {
  const options = fastOptions(bucket, extra);
  return openSnapshot(BASE_URL, await loadLatest(BASE_URL, options), options);
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function corrupted(path, mutate) {
  const bytes = bucket.files.get(path).slice();
  mutate(bytes);
  return bytes;
}

describe("normalizeBaseUrl", () => {
  it("adds a trailing slash and drops query and fragment", () => {
    expect(normalizeBaseUrl("https://graph.example.com")).toBe("https://graph.example.com/");
    expect(normalizeBaseUrl(" https://example.com/graph?x=1#y ")).toBe(
      "https://example.com/graph/",
    );
    expect(normalizeBaseUrl("http://localhost:8787/")).toBe("http://localhost:8787/");
  });

  it("explains a missing or unusable URL", async () => {
    for (const value of ["", "   ", undefined, "not a url", "ftp://example.com/"]) {
      const error = await rejection(Promise.resolve().then(() => normalizeBaseUrl(value)));
      expect(error).toBeInstanceOf(GraphError);
      expect(error.code).toBe("config");
    }
    expect(() => normalizeBaseUrl("")).toThrow(/VITE_WIKI_GRAPH_BASE_URL/);
  });
});

describe("snapshotRoot", () => {
  it("refuses IDs that could escape the snapshots directory", () => {
    expect(snapshotRoot("20260101")).toBe("snapshots/20260101/");
    for (const id of ["", "../x", "a/b", "a.b", "x".repeat(65), null]) {
      expect(() => snapshotRoot(id)).toThrow(GraphError);
    }
  });
});

describe("loadLatest", () => {
  it("reads the pointer and always revalidates it", async () => {
    const latest = await loadLatest(BASE_URL, fastOptions(bucket));
    expect(latest.snapshotId).toBe(expected.snapshotId);
    expect(latest.manifestPath).toBe(`${ROOT}manifest.json`);
    expect(bucket.requests).toEqual([{ path: "latest.json", cache: "no-cache" }]);
  });

  it("rejects pointers it cannot trust", async () => {
    const good = bucket.json("latest.json");
    const cases = [
      [{ ...good, schemaVersion: 2 }, "unsupported"],
      [{ ...good, snapshotId: "../evil" }, "corrupt"],
      [{ ...good, manifestPath: "snapshots/other/manifest.json" }, "corrupt"],
      [{ ...good, manifestSha256: "abc" }, "corrupt"],
      [null, "corrupt"],
    ];
    for (const [value, code] of cases) {
      bucket.put("latest.json", JSON.stringify(value));
      const error = await rejection(loadLatest(BASE_URL, fastOptions(bucket)));
      expect(error.code, JSON.stringify(value)).toBe(code);
    }
    bucket.put("latest.json", "<html>not json</html>");
    expect((await rejection(loadLatest(BASE_URL, fastOptions(bucket)))).code).toBe("corrupt");
  });

  it("reports a missing pointer as an HTTP error without retrying", async () => {
    bucket.files.delete("latest.json");
    const error = await rejection(loadLatest(BASE_URL, fastOptions(bucket)));
    expect(error.code).toBe("http");
    expect(error.status).toBe(404);
    expect(error.transient).toBe(false);
    expect(bucket.requests.length).toBe(1);
  });
});

describe("openSnapshot", () => {
  it("opens the snapshot latest.json points at", async () => {
    const graph = await open();
    expect(graph.snapshotId).toBe(expected.snapshotId);
    expect(graph.articleCount).toBe(expected.counts.articles);
    expect(graph.startArticle).toEqual(expected.startArticle);
    expect(graph.manifest.counts).toEqual(expected.counts);
  });

  it("rejects a manifest that does not match the pinned hash", async () => {
    const latest = await loadLatest(BASE_URL, fastOptions(bucket));
    bucket.put(
      `${ROOT}manifest.json`,
      corrupted(`${ROOT}manifest.json`, (bytes) => {
        // Change a digit of the article count; the file is still valid JSON.
        const text = new TextDecoder().decode(bytes);
        bytes.set(new TextEncoder().encode(text.replace('"articles": 10', '"articles": 11')));
      }),
    );
    const error = await rejection(openSnapshot(BASE_URL, latest, fastOptions(bucket)));
    expect(error.code).toBe("corrupt");
  });

  it("rejects a manifest for a different snapshot", async () => {
    const manifest = { ...bucket.json(`${ROOT}manifest.json`), snapshotId: "20990101" };
    bucket.put(`${ROOT}manifest.json`, JSON.stringify(manifest));
    const error = await rejection(
      fetchManifest(BASE_URL, expected.snapshotId, undefined, fastOptions(bucket)),
    );
    expect(error.code).toBe("corrupt");
  });

  it("refuses formats it does not understand", () => {
    const manifest = bucket.json(`${ROOT}manifest.json`);
    const code = (value) => {
      try {
        validateManifest(value);
      } catch (error) {
        return error.code;
      }
      return "accepted";
    };
    expect(code(manifest)).toBe("accepted");
    expect(code({ ...manifest, schemaVersion: 2 })).toBe("unsupported");
    expect(code({ ...manifest, titles: { ...manifest.titles, hash: "md5" } })).toBe("unsupported");
    expect(code({ ...manifest, counts: { ...manifest.counts, articles: 0 } })).toBe("corrupt");
    expect(code({ ...manifest, adjacency: { ...manifest.adjacency, shardCount: 99 } })).toBe(
      "corrupt",
    );
    expect(code({ ...manifest, startArticle: { title: "X", ordinal: 10 } })).toBe("corrupt");
    expect(code({ ...manifest, metadata: undefined })).toBe("corrupt");
    expect(code(null)).toBe("corrupt");
  });
});

describe("title resolution", () => {
  it("resolves every article and alias", async () => {
    const graph = await open();
    for (const { title, ordinal } of expected.articles) {
      expect(await graph.resolveTitle(title)).toEqual({ ordinal, isRedirect: false, title });
    }
    for (const [title, ordinal] of Object.entries(expected.aliases)) {
      expect(await graph.resolveTitle(title)).toEqual({ ordinal, isRedirect: true, title });
    }
  });

  it("normalizes link text the way the builder does", async () => {
    const graph = await open();
    for (const { input, ordinal, isRedirect } of expected.lookups) {
      const match = await graph.resolveTitle(input);
      expect(match, input).toMatchObject({ ordinal, isRedirect });
    }
  });

  it("returns null for anything that is not an article", async () => {
    const graph = await open();
    for (const title of [...expected.notFound, "", "#top", " _ "]) {
      expect(await graph.resolveTitle(title), title).toBeNull();
    }
  });
});

describe("adjacency and metadata lookups", () => {
  it("returns the links of every article", async () => {
    const graph = await open();
    for (const { ordinal, links } of expected.articles) {
      expect([...(await graph.getNeighbors(ordinal))], `article ${ordinal}`).toEqual(links);
    }
  });

  it("returns the page ID and title of every article", async () => {
    const graph = await open();
    for (const { ordinal, pageId, title } of expected.articles) {
      expect(await graph.getArticle(ordinal)).toEqual({ ordinal, pageId, title });
    }
  });

  it("only links to articles that exist", async () => {
    const graph = await open();
    for (let ordinal = 0; ordinal < graph.articleCount; ordinal += 1) {
      for (const target of await graph.getNeighbors(ordinal)) {
        expect(target).toBeLessThan(graph.articleCount);
        expect((await graph.getArticle(target)).ordinal).toBe(target);
      }
    }
  });

  it("rejects ordinals outside the graph", async () => {
    const graph = await open();
    for (const ordinal of [-1, expected.counts.articles, 1.5, NaN, "0"]) {
      await expect(graph.getNeighbors(ordinal)).rejects.toThrow(RangeError);
      await expect(graph.getArticle(ordinal)).rejects.toThrow(RangeError);
    }
  });

  it("maps ordinals to adjacency shard ranges", async () => {
    const graph = await open();
    expect(graph.adjacencyShardOf(0)).toBe(0);
    expect(graph.adjacencyShardOf(4)).toBe(1);
    expect(graph.adjacencyShardRange(1)).toEqual([4, 8]);
    expect(graph.adjacencyShardRange(2)).toEqual([8, 10]);
  });

  it("loads reports listed in the manifest", async () => {
    const graph = await open();
    const report = await graph.loadReport("connectivity");
    expect(report.start.reachable).toBe(expected.connectivity.reachableFromStart);
    expect([...(await graph.loadReport("unreachableFromStart"))]).toEqual(
      expected.connectivity.unreachableFromStart,
    );
    expect((await rejection(graph.loadReport("nope"))).code).toBe("config");
  });
});

describe("request behaviour", () => {
  it("fetches each index and shard once and shares concurrent requests", async () => {
    const graph = await open();
    bucket.requests.length = 0;
    await Promise.all([graph.getNeighbors(0), graph.getNeighbors(1), graph.getNeighbors(3)]);
    await graph.getNeighbors(2);
    expect(bucket.requests.map((request) => request.path).sort()).toEqual([
      `${ROOT}adjacency/000000.bin`,
      `${ROOT}adjacency/index.bin`,
    ]);
    await graph.getNeighbors(4);
    expect(bucket.requestCount(/adjacency\/index\.bin$/)).toBe(1);
    expect(bucket.requestCount(/adjacency\/000001\.bin$/)).toBe(1);
  });

  it("keeps a bounded number of decoded shards", async () => {
    const graph = await open({ cache: { adjacency: { maxEntries: 1 } } });
    await graph.getNeighbors(0);
    await graph.getNeighbors(4);
    expect(graph.isAdjacencyShardCached(0)).toBe(false);
    expect(graph.isAdjacencyShardCached(1)).toBe(true);
    await graph.getNeighbors(0);
    expect(bucket.requestCount(/adjacency\/000000\.bin$/)).toBe(2);
    expect(graph.caches.adjacency.size).toBe(1);
  });

  it("starts from a saved manifest without any request", async () => {
    const opened = await open();
    bucket.requests.length = 0;
    const graph = new GraphClient({
      baseUrl: BASE_URL,
      manifest: JSON.parse(JSON.stringify(opened.manifest)),
      manifestSha256: opened.manifestSha256,
      options: fastOptions(bucket),
    });
    expect(bucket.requests.length).toBe(0);
    expect([...(await graph.getNeighbors(0))]).toEqual(expected.articles[0].links);
  });
});

describe("failures", () => {
  it("retries transient network failures and then succeeds", async () => {
    const graph = await open();
    let failures = 2;
    bucket.overrides.set(`${ROOT}adjacency/000000.bin`, () =>
      failures-- > 0 ? new TypeError("Failed to fetch") : undefined,
    );
    expect([...(await graph.getNeighbors(0))]).toEqual(expected.articles[0].links);
    expect(bucket.requestCount(/adjacency\/000000\.bin$/)).toBe(3);
  });

  it("retries server errors but not missing files", async () => {
    const graph = await open();
    let failures = 1;
    bucket.overrides.set(`${ROOT}adjacency/000000.bin`, () =>
      failures-- > 0 ? new Response("busy", { status: 503 }) : undefined,
    );
    await graph.getNeighbors(0);
    expect(bucket.requestCount(/adjacency\/000000\.bin$/)).toBe(2);

    bucket.files.delete(`${ROOT}adjacency/000001.bin`);
    const error = await rejection(graph.getNeighbors(4));
    expect(error.code).toBe("http");
    expect(error.transient).toBe(false);
    expect(bucket.requestCount(/adjacency\/000001\.bin$/)).toBe(1);
  });

  it("gives up after the configured retries when offline, then recovers", async () => {
    const graph = await open({ retries: 2 });
    bucket.offline = true;
    const error = await rejection(graph.getNeighbors(0));
    expect(error).toBeInstanceOf(GraphError);
    expect(error.code).toBe("network");
    expect(error.transient).toBe(true);
    expect(bucket.requestCount(/adjacency\/index\.bin$/)).toBe(3);

    bucket.offline = false;
    expect([...(await graph.getNeighbors(0))]).toEqual(expected.articles[0].links);
  });

  it("rejects a shard whose bytes do not match the recorded hash", async () => {
    const graph = await open();
    const path = `${ROOT}adjacency/000000.bin`;
    // Swap one link target; the shard still decodes and has the same length.
    bucket.put(path, corrupted(path, (bytes) => void (bytes[bytes.length - 4] ^= 1)));
    const error = await rejection(graph.getNeighbors(0));
    expect(error.code).toBe("corrupt");
    expect(error.transient).toBe(false);
    // One retry that bypasses the HTTP cache, then stop.
    expect(bucket.requests.filter((request) => request.path === path)).toEqual([
      { path, cache: "default" },
      { path, cache: "reload" },
    ]);
    expect(graph.isAdjacencyShardCached(0)).toBe(false);
  });

  it("recovers when a corrupt copy is replaced by a good one", async () => {
    const graph = await open();
    const path = `${ROOT}titles/000000.bin`;
    const good = bucket.files.get(path);
    let served = 0;
    bucket.overrides.set(path, () => {
      served += 1;
      return served === 1 ? new Response(good.slice(0, good.length - 1)) : undefined;
    });
    for (const { title, ordinal } of expected.articles) {
      expect((await graph.resolveTitle(title)).ordinal).toBe(ordinal);
    }
    expect(served).toBe(2);
  });

  it("rejects a truncated shard and a tampered index", async () => {
    const graph = await open();
    const shard = `${ROOT}metadata/000000.bin`;
    bucket.put(shard, bucket.files.get(shard).slice(0, 20));
    expect((await rejection(graph.getArticle(0))).code).toBe("corrupt");

    const index = `${ROOT}adjacency/index.bin`;
    bucket.put(index, corrupted(index, (bytes) => void (bytes[bytes.length - 1] ^= 0xff)));
    expect((await rejection(graph.getNeighbors(0))).code).toBe("corrupt");
  });

  it("rejects a valid shard served under the wrong name", async () => {
    // Without hashes only the header check stands between the client and a
    // shard that belongs to another range.
    const graph = await open({ verifyHashes: false });
    const wrong = bucket.files.get(`${ROOT}adjacency/000001.bin`);
    bucket.put(`${ROOT}adjacency/000000.bin`, wrong);
    const index = bucket.files.get(`${ROOT}adjacency/index.bin`).slice();
    index.set(index.subarray(16 + 36, 16 + 72), 16);
    bucket.put(`${ROOT}adjacency/index.bin`, index);
    expect((await rejection(graph.getNeighbors(0))).code).toBe("corrupt");
  });

  it("checks lengths even when hashing is unavailable", async () => {
    const graph = await open({ subtle: null });
    const path = `${ROOT}adjacency/000000.bin`;
    expect([...(await graph.getNeighbors(4))]).toEqual(expected.articles[4].links);
    bucket.put(path, bucket.files.get(path).slice(0, 40));
    expect((await rejection(graph.getNeighbors(0))).code).toBe("corrupt");
  });
});
