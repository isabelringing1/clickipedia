// Verifies a published snapshot the way a browser will read it: over its
// public URL, through the same client code the game uses.
//
// It checks content (hashes, decoding, title and adjacency lookups) and the
// HTTP behaviour the game depends on (CORS for the allowed origins only,
// long-lived caching for snapshot files, short caching for latest.json).

import { GraphError, loadLatest, normalizeBaseUrl, openSnapshot } from "../../../src/wikiGraph/client.js";
import {
  IMMUTABLE_CACHE_CONTROL,
  LATEST_CACHE_CONTROL,
  LATEST_KEY,
  UsageError,
  formatBytes,
  snapshotPrefix,
} from "./lib.mjs";

export const DEFAULT_SAMPLES = 12;
// An origin that must not be granted access when CORS is restricted.
const FOREIGN_ORIGIN = "https://cors-probe.invalid";

// Deterministic sampling, so a failed run can be repeated exactly.
function sampler(seedText) {
  let state = 0x9e3779b9;
  for (const char of seedText) {
    state = Math.imul(state ^ char.codePointAt(0), 0x01000193) >>> 0;
  }
  return (bound) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % bound;
  };
}

function pickIndexes(count, samples, random) {
  if (samples >= count) {
    return Array.from({ length: count }, (_, index) => index);
  }
  // Always include both ends: the last shard is the only partial one.
  const chosen = new Set([0, count - 1]);
  while (chosen.size < samples) {
    chosen.add(random(count));
  }
  return [...chosen].sort((a, b) => a - b);
}

function normalizeHeader(value) {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export async function verifyPublicSnapshot({
  baseUrl,
  snapshotId,
  manifestSha256,
  origins,
  samples = DEFAULT_SAMPLES,
  all = false,
  expectLinks = [],
  allowAnyOrigin = false,
  expectLatest = false,
  fetch = globalThis.fetch,
  log = console.log,
}) {
  const base = normalizeBaseUrl(baseUrl);
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new UsageError("At least one --origin is required to check CORS.");
  }
  const problems = [];
  const problem = (message) => {
    if (problems.includes(message)) {
      return;
    }
    problems.push(message);
    log(`  PROBLEM: ${message}`);
  };
  const stats = { requests: 0, bytes: 0 };
  const seen = new Map();

  // Every request the client makes goes through here, as the first allowed
  // origin, and its response headers are recorded for the checks below.
  const observedFetch = async (url, init = {}) => {
    const response = await fetch(url, {
      ...init,
      headers: { ...init.headers, Origin: origins[0] },
    });
    stats.requests += 1;
    stats.bytes += Number(response.headers.get("content-length") ?? 0);
    if (response.ok) {
      seen.set(url, {
        cacheControl: response.headers.get("cache-control"),
        contentType: response.headers.get("content-type"),
        allowOrigin: response.headers.get("access-control-allow-origin"),
      });
    }
    return response;
  };
  const options = { fetch: observedFetch, retries: 2 };

  try {
    log(`Verifying ${base}${snapshotPrefix(snapshotId)}`);
    const graph = await openSnapshot(base, { snapshotId, manifestSha256 }, options);
    const { manifest } = graph;
    log(
      `  manifest ok: ${manifest.counts.articles.toLocaleString()} articles, ` +
        `${manifest.counts.edges.toLocaleString()} links`,
    );

    const random = sampler(snapshotId);
    for (const kind of ["adjacency", "metadata", "titles"]) {
      await graph.loadIndex(kind);
      const count = graph.shardCount(kind);
      const indexes = pickIndexes(count, all ? count : samples, random);
      for (const index of indexes) {
        // loadShard checks length, SHA-256, structure, and the covered range.
        await graph.loadShard(kind, index);
      }
      log(`  ${kind}: ${indexes.length} of ${count} shards match their recorded hashes`);
    }

    const start = manifest.startArticle;
    const resolved = await graph.resolveTitle(start.title);
    if (resolved === null || resolved.ordinal !== start.ordinal || resolved.isRedirect) {
      problem(`the title index does not map "${start.title}" to article ${start.ordinal}`);
    }
    const article = await graph.getArticle(start.ordinal);
    if (article.title !== start.title) {
      problem(`metadata names article ${start.ordinal} "${article.title}", not "${start.title}"`);
    }
    const neighbors = await graph.getNeighbors(start.ordinal);
    if (neighbors.length === 0) {
      problem(`the start article "${start.title}" has no links`);
    }
    for (let i = 0; i < neighbors.length; i += 1) {
      if (neighbors[i] >= graph.articleCount || (i > 0 && neighbors[i] <= neighbors[i - 1])) {
        problem(`the links of "${start.title}" are not ascending article ordinals`);
        break;
      }
    }
    // Round trip through all three shard kinds: link -> title -> ordinal.
    for (const target of [...neighbors].slice(0, 3)) {
      const linked = await graph.getArticle(target);
      const back = await graph.resolveTitle(linked.title);
      if (back === null || back.ordinal !== target) {
        problem(`"${linked.title}" (article ${target}) does not resolve back to itself`);
      }
    }
    log(`  lookups ok: "${start.title}" has ${neighbors.length} links`);

    for (const [from, to] of expectLinks) {
      const source = await graph.resolveTitle(from);
      const target = await graph.resolveTitle(to);
      if (source === null || target === null) {
        problem(`expected link ${from} -> ${to}: ${source === null ? from : to} is not an article`);
      } else if (!(await graph.getNeighbors(source.ordinal)).includes(target.ordinal)) {
        problem(`expected link ${from} -> ${to} is not in the graph`);
      }
    }

    const report = await graph.loadReport("connectivity");
    if (report.articles !== manifest.counts.articles || report.edges !== manifest.counts.edges) {
      problem("the connectivity report disagrees with the manifest's totals");
    }

    // Headers on everything fetched so far.
    for (const [url, headers] of seen) {
      const name = url.slice(base.length);
      const wantedType = name.endsWith(".json") ? "application/json" : "application/octet-stream";
      if (normalizeHeader(headers.cacheControl) !== IMMUTABLE_CACHE_CONTROL) {
        problem(`${name} has Cache-Control "${headers.cacheControl}", expected "${IMMUTABLE_CACHE_CONTROL}"`);
      }
      if (!normalizeHeader(headers.contentType).startsWith(wantedType)) {
        problem(`${name} has Content-Type "${headers.contentType}", expected ${wantedType}`);
      }
    }
    log(`  cache and content-type headers checked on ${seen.size} responses`);

    // CORS, on one JSON file and one binary shard. The allowed origins are
    // tried in turn, twice, against the same URLs: the second round is
    // answered from the CDN cache, which must not replay one origin's
    // headers to another.
    const corsTargets = [
      `${base}${snapshotPrefix(snapshotId)}manifest.json`,
      [...seen.keys()].find((url) => /\/\d{6}\.bin$/.test(url)),
    ];
    for (const url of corsTargets) {
      const name = url.slice(base.length);
      for (const origin of [...origins, ...origins]) {
        const response = await fetch(url, { headers: { Origin: origin } });
        stats.requests += 1;
        const allowed = response.headers.get("access-control-allow-origin");
        await response.arrayBuffer();
        if (allowed !== origin && !(allowAnyOrigin && allowed === "*")) {
          problem(
            `${name} requested from ${origin} got Access-Control-Allow-Origin ` +
              `"${allowed ?? "(none)"}"; the browser would block it`,
          );
        }
      }
      if (!allowAnyOrigin) {
        const response = await fetch(url, { headers: { Origin: FOREIGN_ORIGIN } });
        stats.requests += 1;
        const allowed = response.headers.get("access-control-allow-origin");
        await response.arrayBuffer();
        if (allowed === "*" || allowed === FOREIGN_ORIGIN) {
          problem(
            `${name} is readable from any origin (Access-Control-Allow-Origin "${allowed}"); ` +
              "CORS should be limited to the game and localhost (or pass --allow-any-origin)",
          );
        }
      }
    }
    log(`  CORS checked for ${origins.join(", ")}`);

    if (expectLatest) {
      const latestHeaders = [];
      const latest = await loadLatest(base, {
        ...options,
        fetch: async (url, init) => {
          const response = await observedFetch(url, init);
          latestHeaders.push(response.headers.get("cache-control"));
          return response;
        },
      });
      if (latest.snapshotId !== snapshotId) {
        problem(`${LATEST_KEY} points at ${latest.snapshotId}, expected ${snapshotId}`);
      } else if (manifestSha256 !== undefined && latest.manifestSha256 !== manifestSha256) {
        problem(`${LATEST_KEY} pins manifest ${latest.manifestSha256}, expected ${manifestSha256}`);
      }
      if (normalizeHeader(latestHeaders[0]) !== LATEST_CACHE_CONTROL) {
        problem(`${LATEST_KEY} has Cache-Control "${latestHeaders[0]}", expected "${LATEST_CACHE_CONTROL}"`);
      }
      log(`  ${LATEST_KEY} points at ${latest.snapshotId}`);
    }
  } catch (error) {
    if (!(error instanceof GraphError)) {
      throw error;
    }
    problem(error.message);
  }

  if (problems.length > 0) {
    throw new UsageError(
      `Public verification of ${snapshotId} failed:\n` +
        problems.map((message) => `  - ${message}`).join("\n"),
    );
  }
  log(`Verified: ${stats.requests} requests, ${formatBytes(stats.bytes)} downloaded.`);
  return stats;
}
