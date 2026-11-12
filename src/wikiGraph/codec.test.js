import { describe, expect, it } from "vitest";

import { expected, readFixtureFiles, sha256Hex } from "../testing/fixtureGraph.js";
import {
  FormatError,
  KIND_ADJACENCY,
  KIND_METADATA,
  KIND_TITLES,
  decodeAdjacencyShard,
  decodeMetadataShard,
  decodeOrdinalList,
  decodeShardIndex,
  decodeTitleBucket,
  shardPath,
  toHex,
} from "./codec.js";
import { bucketFor, titleBytes } from "./titles.js";

const files = readFixtureFiles();
const root = `snapshots/${expected.snapshotId}/`;
const file = (path) => files.get(root + path);
const manifest = JSON.parse(new TextDecoder().decode(file("manifest.json")));

function u32(...values) {
  return new Uint8Array(new Uint32Array(values).buffer);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const ascii = (text) => new TextEncoder().encode(text);

// Same sample as the Rust format tests: sources 8..10 with five targets.
const sampleAdjacency = concat(
  ascii("CKAJ"),
  u32(1, 8, 3),
  u32(0, 2, 2, 5),
  u32(1, 9, 0, 3, 4_000_000_000),
);

describe("adjacency shards", () => {
  it("decodes the layout the Rust encoder writes", () => {
    const shard = decodeAdjacencyShard(sampleAdjacency);
    expect(shard.firstOrdinal).toBe(8);
    expect(shard.count).toBe(3);
    expect([...shard.neighbors(0)]).toEqual([1, 9]);
    expect([...shard.neighbors(1)]).toEqual([]);
    expect([...shard.neighbors(2)]).toEqual([0, 3, 4_000_000_000]);
  });

  it("accepts ArrayBuffers and unaligned views", () => {
    expect([...decodeAdjacencyShard(sampleAdjacency.buffer).neighbors(0)]).toEqual([1, 9]);
    const shifted = new Uint8Array(sampleAdjacency.length + 1);
    shifted.set(sampleAdjacency, 1);
    const shard = decodeAdjacencyShard(shifted.subarray(1));
    expect([...shard.neighbors(2)]).toEqual([0, 3, 4_000_000_000]);
  });

  it("rejects out-of-range local indexes", () => {
    const shard = decodeAdjacencyShard(sampleAdjacency);
    expect(() => shard.neighbors(3)).toThrow(RangeError);
    expect(() => shard.neighbors(-1)).toThrow(RangeError);
    expect(() => shard.neighbors(0.5)).toThrow(RangeError);
  });

  it("rejects corruption", () => {
    const corrupt = (mutate) => {
      const bytes = sampleAdjacency.slice();
      return mutate(bytes) ?? bytes;
    };
    const cases = {
      "missing target": corrupt((bytes) => bytes.subarray(0, bytes.length - 4)),
      "partial word": corrupt((bytes) => bytes.subarray(0, bytes.length - 1)),
      "short header": corrupt((bytes) => bytes.subarray(0, 10)),
      "bad magic": corrupt((bytes) => void (bytes[0] = 0x58)),
      "bad version": corrupt((bytes) => void (bytes[4] = 2)),
      "decreasing offsets": corrupt((bytes) => void (bytes[16 + 4] = 3)),
      "extra target": concat(sampleAdjacency, u32(0)),
      "nonzero first offset": corrupt((bytes) => void (bytes[16] = 1)),
    };
    for (const [label, bytes] of Object.entries(cases)) {
      expect(() => decodeAdjacencyShard(bytes), label).toThrow(FormatError);
    }
  });

  it("decodes an empty shard", () => {
    const shard = decodeAdjacencyShard(concat(ascii("CKAJ"), u32(1, 0, 2), u32(0, 0, 0)));
    expect(shard.count).toBe(2);
    expect(shard.neighbors(1).length).toBe(0);
  });

  it("reads every link of the fixture graph", () => {
    const { shardSize, shardCount, dir } = manifest.adjacency;
    expect(shardSize).toBe(expected.format.adjacencyShardSize);
    const links = [];
    for (let index = 0; index < shardCount; index += 1) {
      const shard = decodeAdjacencyShard(file(shardPath(dir, index)));
      expect(shard.firstOrdinal).toBe(index * shardSize);
      for (let local = 0; local < shard.count; local += 1) {
        links.push([...shard.neighbors(local)]);
      }
    }
    expect(links).toEqual(expected.articles.map((article) => article.links));
    expect(links.flat().length).toBe(expected.counts.edges);
  });
});

describe("metadata shards", () => {
  it("reads every fixture article", () => {
    const { shardCount, dir } = manifest.metadata;
    const articles = [];
    for (let index = 0; index < shardCount; index += 1) {
      const shard = decodeMetadataShard(file(shardPath(dir, index)));
      for (let local = 0; local < shard.count; local += 1) {
        articles.push(shard.article(local));
      }
    }
    expect(articles).toEqual(
      expected.articles.map(({ ordinal, pageId, title }) => ({ ordinal, pageId, title })),
    );
  });

  it("rejects truncation and bad title offsets", () => {
    const bytes = file(shardPath(manifest.metadata.dir, 0));
    expect(() => decodeMetadataShard(bytes.subarray(0, bytes.length - 1))).toThrow(FormatError);
    expect(() => decodeMetadataShard(bytes.subarray(0, 20))).toThrow(FormatError);
    expect(() => decodeMetadataShard(concat(bytes, ascii("x")))).toThrow(FormatError);
  });

  it("rejects out-of-range local indexes", () => {
    const shard = decodeMetadataShard(file(shardPath(manifest.metadata.dir, 0)));
    expect(() => shard.article(shard.count)).toThrow(RangeError);
  });
});

describe("title buckets", () => {
  const bucketCount = manifest.titles.bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, index) =>
    decodeTitleBucket(file(shardPath(manifest.titles.dir, index))),
  );
  const lookup = (title) => {
    const bytes = titleBytes(title);
    return buckets[bucketFor(bytes, bucketCount)].lookup(bytes);
  };

  it("finds every article under its own title", () => {
    for (const { title, ordinal } of expected.articles) {
      expect(lookup(title), title).toEqual({ ordinal, isRedirect: false });
    }
  });

  it("finds every redirect alias", () => {
    for (const [title, ordinal] of Object.entries(expected.aliases)) {
      expect(lookup(title), title).toEqual({ ordinal, isRedirect: true });
    }
  });

  it("does not find titles that are not articles", () => {
    for (const title of expected.notFound) {
      expect(lookup(title), title).toBeNull();
    }
    expect(lookup("")).toBeNull();
  });

  it("holds exactly the expected number of entries, each in its hash bucket", () => {
    let entries = 0;
    buckets.forEach((bucket, index) => {
      expect(bucket.bucket).toBe(index);
      for (let i = 0; i < bucket.count; i += 1) {
        expect(bucketFor(titleBytes(bucket.entry(i).title), bucketCount)).toBe(index);
      }
      entries += bucket.count;
    });
    expect(entries).toBe(expected.counts.titleEntries);
  });

  it("orders titles by UTF-8 bytes, not UTF-16 code units", () => {
    // U+FF5E sorts before U+1F600 in UTF-8 but after it in UTF-16.
    const titles = ["A", "～", "😀"].map(titleBytes);
    const offsets = [0];
    for (const title of titles) {
      offsets.push(offsets[offsets.length - 1] + title.length);
    }
    const bytes = concat(
      ascii("CKTB"),
      u32(1, 0, 3),
      u32(10, 11, 12),
      u32(...offsets),
      new Uint8Array([0, 1, 0]),
      ...titles,
    );
    const bucket = decodeTitleBucket(bytes);
    expect(bucket.lookup(titleBytes("～"))).toEqual({ ordinal: 11, isRedirect: true });
    expect(bucket.lookup(titleBytes("😀"))).toEqual({ ordinal: 12, isRedirect: false });
    expect(bucket.lookup(titleBytes("B"))).toBeNull();
  });

  it("rejects unsorted or duplicate titles", () => {
    const build = (a, b) =>
      concat(ascii("CKTB"), u32(1, 0, 2), u32(1, 2), u32(0, 1, 2), new Uint8Array(2), ascii(a + b));
    expect(() => decodeTitleBucket(build("B", "A"))).toThrow(FormatError);
    expect(() => decodeTitleBucket(build("A", "A"))).toThrow(FormatError);
    expect(decodeTitleBucket(build("A", "B")).count).toBe(2);
  });

  it("decodes an empty bucket", () => {
    const bucket = decodeTitleBucket(concat(ascii("CKTB"), u32(1, 7, 0), u32(0)));
    expect(bucket.bucket).toBe(7);
    expect(bucket.lookup(titleBytes("A"))).toBeNull();
  });
});

describe("shard indexes", () => {
  it("records the length and hash of every fixture shard", () => {
    const kinds = [
      ["adjacency", KIND_ADJACENCY, manifest.adjacency.shardCount],
      ["metadata", KIND_METADATA, manifest.metadata.shardCount],
      ["titles", KIND_TITLES, manifest.titles.bucketCount],
    ];
    for (const [name, kind, count] of kinds) {
      const index = decodeShardIndex(file(manifest[name].index.path));
      expect(index.kind).toBe(kind);
      expect(index.count).toBe(count);
      for (let i = 0; i < count; i += 1) {
        const bytes = file(shardPath(manifest[name].dir, i));
        const entry = index.entry(i);
        expect(entry.bytes).toBe(bytes.length);
        expect(toHex(entry.sha256)).toBe(sha256Hex(bytes));
      }
      expect(() => index.entry(count)).toThrow(RangeError);
    }
  });

  it("rejects a length that does not match the entry count", () => {
    const bytes = file(manifest.adjacency.index.path);
    expect(() => decodeShardIndex(bytes.subarray(0, bytes.length - 1))).toThrow(FormatError);
    expect(() => decodeShardIndex(concat(bytes, u32(0)))).toThrow(FormatError);
  });
});

describe("ordinal lists", () => {
  it("reads the fixture connectivity lists", () => {
    const read = (name) => [...decodeOrdinalList(file(manifest.reports[name].path))];
    expect(read("zeroIndegree")).toEqual(expected.connectivity.zeroIndegree);
    expect(read("isolated")).toEqual(expected.connectivity.isolated);
    expect(read("unreachableFromStart")).toEqual(expected.connectivity.unreachableFromStart);
  });

  it("rejects partial words", () => {
    expect(() => decodeOrdinalList(new Uint8Array(6))).toThrow(FormatError);
  });
});

describe("shardPath", () => {
  it("zero-pads like the builder", () => {
    expect(shardPath("adjacency", 42)).toBe("adjacency/000042.bin");
    expect(shardPath("titles", 1234567)).toBe("titles/1234567.bin");
  });
});
