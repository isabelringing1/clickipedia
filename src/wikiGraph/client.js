// Reads an immutable Wikipedia link-graph snapshot over HTTP.
//
// A snapshot is a directory of small binary shards (see codec.js). The client
// fetches only the shards a lookup needs, checks each one against the byte
// length and SHA-256 recorded in the snapshot's index files, and keeps a
// bounded number of decoded shards in memory.

import {
  KIND_ADJACENCY,
  KIND_METADATA,
  KIND_TITLES,
  FormatError,
  decodeAdjacencyShard,
  decodeMetadataShard,
  decodeOrdinalList,
  decodeShardIndex,
  decodeTitleBucket,
  shardPath,
  toHex,
} from "./codec.js";
import { LruCache } from "./lru.js";
import { TITLE_HASH_NAME, bucketFor, normalizeTitle, titleBytes } from "./titles.js";

export const SCHEMA_VERSION = 1;
export const LATEST_FILE = "latest.json";

const MIB = 1024 * 1024;
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const DEFAULT_OPTIONS = {
  // Attempts after the first one, for failures that might be transient.
  retries: 3,
  retryDelayMs: 400,
  timeoutMs: 30000,
  verifyHashes: true,
  cache: {
    adjacency: { maxEntries: 48, maxWeight: 64 * MIB },
    metadata: { maxEntries: 48, maxWeight: 16 * MIB },
    titles: { maxEntries: 96, maxWeight: 24 * MIB },
  },
};

// `code` says what went wrong so callers can react without parsing messages:
//   config       the base URL or an argument is unusable
//   network      the request never produced a response (offline, DNS, CORS)
//   http         the server answered with an error status
//   corrupt      bytes did not match the snapshot's recorded length or hash
//   unsupported  the snapshot uses a format this client does not understand
export class GraphError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GraphError";
    this.code = code;
    this.url = options.url;
    this.status = options.status;
  }

  // True when trying again later could succeed.
  get transient() {
    return (
      this.code === "network" ||
      (this.code === "http" && (this.status >= 500 || this.status === 408 || this.status === 429))
    );
  }
}

export function normalizeBaseUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new GraphError(
      "config",
      "The link graph URL is not configured. Set VITE_WIKI_GRAPH_BASE_URL (see .env.example).",
    );
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch (cause) {
    throw new GraphError("config", `The link graph URL "${raw}" is not a valid URL.`, { cause });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new GraphError("config", `The link graph URL "${raw}" must use http or https.`);
  }
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url.href;
}

export function snapshotRoot(snapshotId) {
  if (typeof snapshotId !== "string" || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new GraphError("config", `"${snapshotId}" is not a valid snapshot ID.`);
  }
  return `snapshots/${snapshotId}/`;
}

function resolveOptions(options = {}) {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    cache: { ...DEFAULT_OPTIONS.cache, ...options.cache },
    fetch: options.fetch ?? ((...args) => globalThis.fetch(...args)),
    subtle: options.subtle === undefined ? globalThis.crypto?.subtle : options.subtle,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

let warnedAboutMissingCrypto = false;

async function sha256Hex(subtle, buffer) {
  return toHex(new Uint8Array(await subtle.digest("SHA-256", buffer)));
}

// Fetches `url` and returns its bytes. When `expected` is given, the bytes
// must match its length and (if hashing is possible) its SHA-256.
//
// Transient failures are retried with backoff. A mismatch is retried once
// with the HTTP cache bypassed, in case a bad copy is stuck in the cache.
async function fetchBytes(url, expected, options) {
  let lastError;
  // "no-cache" revalidates with the server; "reload" ignores the cache.
  let cacheMode = options.revalidate === true ? "no-cache" : "default";
  let corruptAttempts = 0;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    if (attempt > 0) {
      await options.sleep(options.retryDelayMs * 2 ** (attempt - 1));
    }

    let response;
    try {
      const init = { cache: cacheMode };
      if (options.timeoutMs > 0 && typeof AbortSignal?.timeout === "function") {
        init.signal = AbortSignal.timeout(options.timeoutMs);
      }
      response = await options.fetch(url, init);
    } catch (cause) {
      lastError = new GraphError("network", `Could not reach ${url}.`, { cause, url });
      continue;
    }

    if (!response.ok) {
      lastError = new GraphError("http", `${url} answered with HTTP ${response.status}.`, {
        url,
        status: response.status,
      });
      if (lastError.transient) {
        continue;
      }
      throw lastError;
    }

    let buffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (cause) {
      lastError = new GraphError("network", `The download of ${url} was interrupted.`, {
        cause,
        url,
      });
      continue;
    }

    const problem = await findMismatch(buffer, expected, options);
    if (problem === null) {
      return buffer;
    }
    lastError = new GraphError("corrupt", `${url} ${problem}.`, { url });
    corruptAttempts += 1;
    if (corruptAttempts > 1) {
      break;
    }
    cacheMode = "reload";
  }

  throw lastError;
}

async function findMismatch(buffer, expected, options) {
  if (!expected) {
    return null;
  }
  if (buffer.byteLength !== expected.bytes) {
    return `is ${buffer.byteLength} bytes, expected ${expected.bytes}`;
  }
  if (!options.verifyHashes || expected.sha256 === undefined) {
    return null;
  }
  if (!options.subtle) {
    // Hashing needs a secure context (HTTPS or localhost).
    if (!warnedAboutMissingCrypto) {
      warnedAboutMissingCrypto = true;
      console.warn("Web Crypto is unavailable; link graph files are checked by length only.");
    }
    return null;
  }
  const actual = await sha256Hex(options.subtle, buffer);
  const wanted = typeof expected.sha256 === "string" ? expected.sha256 : toHex(expected.sha256);
  return actual === wanted ? null : "does not match its recorded SHA-256";
}

function parseJson(buffer, url) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch (cause) {
    throw new GraphError("corrupt", `${url} is not valid JSON.`, { cause, url });
  }
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function isFileRef(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.path === "string" &&
    isCount(value.bytes) &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256)
  );
}

// Rejects manifests this client cannot read, with a reason.
export function validateManifest(manifest) {
  const reject = (code, message) => {
    throw new GraphError(code, `Snapshot manifest ${message}.`);
  };
  if (manifest === null || typeof manifest !== "object") {
    reject("corrupt", "is not an object");
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    reject("unsupported", `has schema version ${manifest.schemaVersion}, expected ${SCHEMA_VERSION}`);
  }
  if (typeof manifest.snapshotId !== "string" || !SNAPSHOT_ID_PATTERN.test(manifest.snapshotId)) {
    reject("corrupt", "has an invalid snapshot ID");
  }
  const counts = manifest.counts;
  if (!counts || !isCount(counts.articles) || counts.articles === 0) {
    reject("corrupt", "has no article count");
  }
  const start = manifest.startArticle;
  if (!start || typeof start.title !== "string" || !isCount(start.ordinal)) {
    reject("corrupt", "has no start article");
  }
  if (start.ordinal >= counts.articles) {
    reject("corrupt", "has a start article outside the article range");
  }
  for (const kind of ["adjacency", "metadata"]) {
    const section = manifest[kind];
    if (
      !section ||
      typeof section.dir !== "string" ||
      !isCount(section.shardSize) ||
      section.shardSize === 0 ||
      !isCount(section.shardCount) ||
      !isFileRef(section.index)
    ) {
      reject("corrupt", `has an invalid ${kind} section`);
    }
    if (section.shardCount !== Math.ceil(counts.articles / section.shardSize)) {
      reject("corrupt", `has an inconsistent ${kind} shard count`);
    }
  }
  const titles = manifest.titles;
  if (
    !titles ||
    typeof titles.dir !== "string" ||
    !isCount(titles.bucketCount) ||
    titles.bucketCount === 0 ||
    !isFileRef(titles.index)
  ) {
    reject("corrupt", "has an invalid titles section");
  }
  if (titles.hash !== TITLE_HASH_NAME) {
    reject("unsupported", `uses the unknown title hash "${titles.hash}"`);
  }
  return manifest;
}

// Reads the pointer to the newest published snapshot. It is the only mutable
// file, so it is always revalidated with the server.
export async function loadLatest(baseUrl, options) {
  const base = normalizeBaseUrl(baseUrl);
  const url = base + LATEST_FILE;
  const resolved = resolveOptions(options);
  const latest = parseJson(await fetchBytes(url, null, { ...resolved, revalidate: true }), url);
  if (latest === null || typeof latest !== "object") {
    throw new GraphError("corrupt", `${url} is not an object.`, { url });
  }
  if (latest.schemaVersion !== SCHEMA_VERSION) {
    throw new GraphError(
      "unsupported",
      `${url} has schema version ${latest.schemaVersion}, expected ${SCHEMA_VERSION}.`,
      { url },
    );
  }
  if (
    typeof latest.snapshotId !== "string" ||
    !SNAPSHOT_ID_PATTERN.test(latest.snapshotId) ||
    latest.manifestPath !== `${snapshotRoot(latest.snapshotId)}manifest.json` ||
    typeof latest.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(latest.manifestSha256)
  ) {
    throw new GraphError("corrupt", `${url} does not name a snapshot manifest.`, { url });
  }
  return latest;
}

// Downloads and checks a snapshot manifest. `manifestSha256` pins the exact
// manifest; pass the value from latest.json or from a save.
export async function fetchManifest(baseUrl, snapshotId, manifestSha256, options) {
  const base = normalizeBaseUrl(baseUrl);
  const url = `${base}${snapshotRoot(snapshotId)}manifest.json`;
  const resolved = resolveOptions(options);
  const buffer = await fetchBytes(url, null, resolved);
  if (manifestSha256 !== undefined && resolved.verifyHashes && resolved.subtle) {
    const actual = await sha256Hex(resolved.subtle, buffer);
    if (actual !== manifestSha256) {
      throw new GraphError("corrupt", `${url} does not match its pinned SHA-256.`, { url });
    }
  }
  const manifest = validateManifest(parseJson(buffer, url));
  if (manifest.snapshotId !== snapshotId) {
    throw new GraphError("corrupt", `${url} describes snapshot ${manifest.snapshotId}.`, { url });
  }
  return manifest;
}

// Opens the snapshot named by a latest.json pointer or a saved pin.
export async function openSnapshot(baseUrl, { snapshotId, manifestSha256 }, options) {
  const manifest = await fetchManifest(baseUrl, snapshotId, manifestSha256, options);
  return new GraphClient({ baseUrl, manifest, manifestSha256, options });
}

const KINDS = {
  adjacency: { kind: KIND_ADJACENCY, decode: decodeAdjacencyShard },
  metadata: { kind: KIND_METADATA, decode: decodeMetadataShard },
  titles: { kind: KIND_TITLES, decode: decodeTitleBucket },
};

export class GraphClient {
  // `manifest` may come from fetchManifest or from a save; a saved manifest
  // lets the game start without any request, because snapshots never change.
  constructor({ baseUrl, manifest, manifestSha256, options }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.manifest = validateManifest(manifest);
    this.manifestSha256 = manifestSha256;
    this.options = resolveOptions(options);
    this.root = this.baseUrl + snapshotRoot(manifest.snapshotId);
    this.caches = {
      adjacency: new LruCache(this.options.cache.adjacency),
      metadata: new LruCache(this.options.cache.metadata),
      titles: new LruCache(this.options.cache.titles),
    };
    this.indexes = new Map();
    this.inFlight = new Map();
    this.stats = { requests: 0, bytes: 0 };
  }

  get snapshotId() {
    return this.manifest.snapshotId;
  }

  get articleCount() {
    return this.manifest.counts.articles;
  }

  get startArticle() {
    return this.manifest.startArticle;
  }

  shardCount(name) {
    return name === "titles" ? this.manifest.titles.bucketCount : this.manifest[name].shardCount;
  }

  adjacencyShardOf(ordinal) {
    return Math.floor(ordinal / this.manifest.adjacency.shardSize);
  }

  // The ordinal range [first, end) covered by one adjacency shard.
  adjacencyShardRange(shardIndex) {
    const size = this.manifest.adjacency.shardSize;
    const first = shardIndex * size;
    return [first, Math.min(first + size, this.articleCount)];
  }

  isAdjacencyShardCached(shardIndex) {
    return this.caches.adjacency.has(shardIndex);
  }

  metadataShardOf(ordinal) {
    return Math.floor(ordinal / this.manifest.metadata.shardSize);
  }

  // True when getArticle for this shard's articles needs no download.
  isMetadataShardCached(shardIndex) {
    return this.caches.metadata.has(shardIndex);
  }

  async fetchFile(relativePath, expected) {
    const buffer = await fetchBytes(this.root + relativePath, expected, this.options);
    this.stats.requests += 1;
    this.stats.bytes += buffer.byteLength;
    return buffer;
  }

  // Shares one request between concurrent callers and forgets failures so a
  // later call can try again.
  once(key, load) {
    let pending = this.inFlight.get(key);
    if (pending === undefined) {
      pending = load().finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  loadIndex(name) {
    const cached = this.indexes.get(name);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    return this.once(`index:${name}`, async () => {
      const ref = this.manifest[name].index;
      const buffer = await this.fetchFile(ref.path, ref);
      const index = this.decode(ref.path, () => decodeShardIndex(buffer));
      if (index.kind !== KINDS[name].kind || index.count !== this.shardCount(name)) {
        throw new GraphError("corrupt", `${ref.path} does not describe the ${name} shards.`);
      }
      this.indexes.set(name, index);
      return index;
    });
  }

  decode(path, run) {
    try {
      return run();
    } catch (cause) {
      if (cause instanceof FormatError) {
        throw new GraphError("corrupt", `${path} is malformed: ${cause.message}`, { cause });
      }
      throw cause;
    }
  }

  loadShard(name, shardIndex) {
    if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= this.shardCount(name)) {
      return Promise.reject(new RangeError(`${name} shard ${shardIndex} does not exist`));
    }
    const cached = this.caches[name].get(shardIndex);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    return this.once(`${name}:${shardIndex}`, async () => {
      const index = await this.loadIndex(name);
      const path = shardPath(this.manifest[name].dir, shardIndex);
      const buffer = await this.fetchFile(path, index.entry(shardIndex));
      const shard = this.decode(path, () => KINDS[name].decode(buffer));
      this.checkShardHeader(name, shardIndex, shard, path);
      this.caches[name].set(shardIndex, shard, shard.byteLength);
      return shard;
    });
  }

  checkShardHeader(name, shardIndex, shard, path) {
    let valid;
    if (name === "titles") {
      valid = shard.bucket === shardIndex;
    } else {
      const size = this.manifest[name].shardSize;
      const first = shardIndex * size;
      valid =
        shard.firstOrdinal === first &&
        shard.count === Math.min(size, this.articleCount - first);
    }
    if (!valid) {
      throw new GraphError("corrupt", `${path} does not cover the range its name implies.`);
    }
  }

  checkOrdinal(ordinal) {
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= this.articleCount) {
      throw new RangeError(`article ordinal ${ordinal} is out of range`);
    }
  }

  loadAdjacencyShard(shardIndex) {
    return this.loadShard("adjacency", shardIndex);
  }

  // Looks up a title (in any spelling normalizeTitle accepts) in the title
  // index. Returns null when the snapshot has no such article or redirect.
  async resolveTitle(title) {
    const normalized = normalizeTitle(title);
    if (normalized === null) {
      return null;
    }
    const bytes = titleBytes(normalized);
    const bucket = await this.loadShard(
      "titles",
      bucketFor(bytes, this.manifest.titles.bucketCount),
    );
    const match = bucket.lookup(bytes);
    if (match === null) {
      return null;
    }
    if (match.ordinal >= this.articleCount) {
      throw new GraphError("corrupt", `The title index maps "${normalized}" outside the graph.`);
    }
    return { ordinal: match.ordinal, isRedirect: match.isRedirect, title: normalized };
  }

  // Ordinals this article links to, ascending. The result is a view into a
  // cached shard: read it, do not modify it.
  async getNeighbors(ordinal) {
    this.checkOrdinal(ordinal);
    const size = this.manifest.adjacency.shardSize;
    const shard = await this.loadShard("adjacency", Math.floor(ordinal / size));
    return shard.neighbors(ordinal % size);
  }

  // The page ID and canonical title of an article.
  async getArticle(ordinal) {
    this.checkOrdinal(ordinal);
    const size = this.manifest.metadata.shardSize;
    const shard = await this.loadShard("metadata", Math.floor(ordinal / size));
    return shard.article(ordinal % size);
  }

  // Loads one of the files listed under `reports` in the manifest: parsed
  // JSON for .json reports, a Uint32Array of ordinals for .bin lists.
  async loadReport(name) {
    const ref = this.manifest.reports?.[name];
    if (!isFileRef(ref)) {
      throw new GraphError("config", `The snapshot has no "${name}" report.`);
    }
    const buffer = await this.fetchFile(ref.path, ref);
    return ref.path.endsWith(".json")
      ? parseJson(buffer, ref.path)
      : this.decode(ref.path, () => decodeOrdinalList(buffer));
  }
}
