// Decoders for the binary shard formats (schema version 1).
//
// These mirror tools/wiki-graph/src/format.rs, which documents the layouts.
// Every file starts with four little-endian u32 words (magic, version, a, b)
// and every integer array is little-endian u32.

export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 16;
export const INDEX_ENTRY_BYTES = 36;

export const KIND_ADJACENCY = 1;
export const KIND_METADATA = 2;
export const KIND_TITLES = 3;

export const TITLE_FLAG_REDIRECT = 1;

const MAGIC_ADJACENCY = "CKAJ";
const MAGIC_METADATA = "CKMD";
const MAGIC_TITLES = "CKTB";
const MAGIC_INDEX = "CKIX";

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const decoder = new TextDecoder("utf-8", { fatal: true });

export class FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "FormatError";
  }
}

function fail(what, message) {
  throw new FormatError(`${what}: ${message}`);
}

function toBytes(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError("expected an ArrayBuffer or typed array");
}

// Reads `count` little-endian u32 values starting at `offset`. The arrays are
// viewed in place when the platform and alignment allow it.
function readU32Array(bytes, offset, count) {
  const start = bytes.byteOffset + offset;
  if (LITTLE_ENDIAN && start % 4 === 0) {
    return new Uint32Array(bytes.buffer, start, count);
  }
  const view = new DataView(bytes.buffer, start, count * 4);
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getUint32(i * 4, true);
  }
  return out;
}

function readHeader(bytes, magic, what) {
  if (bytes.length < HEADER_BYTES) {
    fail(what, `${bytes.length} bytes is too short for a header`);
  }
  for (let i = 0; i < 4; i += 1) {
    if (bytes[i] !== magic.charCodeAt(i)) {
      fail(what, "bad magic bytes");
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  const version = view.getUint32(4, true);
  if (version !== FORMAT_VERSION) {
    fail(what, `unsupported format version ${version}`);
  }
  return [view.getUint32(8, true), view.getUint32(12, true)];
}

// Offsets must start at zero, never decrease, and end at `total`.
function checkOffsets(offsets, total, what) {
  if (offsets[0] !== 0) {
    fail(what, "offsets must start at zero");
  }
  for (let i = 1; i < offsets.length; i += 1) {
    if (offsets[i - 1] > offsets[i]) {
      fail(what, "offsets must not decrease");
    }
  }
  if (offsets[offsets.length - 1] !== total) {
    fail(
      what,
      `final offset ${offsets[offsets.length - 1]} does not match payload length ${total}`,
    );
  }
}

function compareBytes(a, aStart, aEnd, b, bStart, bEnd) {
  const aLength = aEnd - aStart;
  const bLength = bEnd - bStart;
  const shared = Math.min(aLength, bLength);
  for (let i = 0; i < shared; i += 1) {
    const difference = a[aStart + i] - b[bStart + i];
    if (difference !== 0) {
      return difference;
    }
  }
  return aLength - bLength;
}

// Out-links for a contiguous range of source ordinals.
export function decodeAdjacencyShard(data) {
  const what = "adjacency shard";
  const bytes = toBytes(data);
  const [firstOrdinal, count] = readHeader(bytes, MAGIC_ADJACENCY, what);
  const offsetsEnd = HEADER_BYTES + (count + 1) * 4;
  if (bytes.length < offsetsEnd) {
    fail(what, "truncated offsets");
  }
  const payload = bytes.length - offsetsEnd;
  if (payload % 4 !== 0) {
    fail(what, "target bytes are not a multiple of 4");
  }
  const offsets = readU32Array(bytes, HEADER_BYTES, count + 1);
  checkOffsets(offsets, payload / 4, what);
  const targets = readU32Array(bytes, offsetsEnd, payload / 4);

  return {
    firstOrdinal,
    count,
    offsets,
    targets,
    byteLength: bytes.length,
    // Targets of the source at `localIndex`, ascending. A view, not a copy.
    neighbors(localIndex) {
      if (!Number.isInteger(localIndex) || localIndex < 0 || localIndex >= count) {
        throw new RangeError(`${what}: local index ${localIndex} is out of range`);
      }
      return targets.subarray(offsets[localIndex], offsets[localIndex + 1]);
    },
  };
}

// Page IDs and titles for a contiguous range of article ordinals.
export function decodeMetadataShard(data) {
  const what = "metadata shard";
  const bytes = toBytes(data);
  const [firstOrdinal, count] = readHeader(bytes, MAGIC_METADATA, what);
  const offsetsStart = HEADER_BYTES + count * 4;
  const titlesStart = offsetsStart + (count + 1) * 4;
  if (bytes.length < titlesStart) {
    fail(what, "truncated arrays");
  }
  const pageIds = readU32Array(bytes, HEADER_BYTES, count);
  const titleOffsets = readU32Array(bytes, offsetsStart, count + 1);
  const titles = bytes.subarray(titlesStart);
  checkOffsets(titleOffsets, titles.length, what);

  return {
    firstOrdinal,
    count,
    pageIds,
    byteLength: bytes.length,
    article(localIndex) {
      if (!Number.isInteger(localIndex) || localIndex < 0 || localIndex >= count) {
        throw new RangeError(`${what}: local index ${localIndex} is out of range`);
      }
      return {
        ordinal: firstOrdinal + localIndex,
        pageId: pageIds[localIndex],
        title: decoder.decode(
          titles.subarray(titleOffsets[localIndex], titleOffsets[localIndex + 1]),
        ),
      };
    },
  };
}

// One hash partition of the title index (articles plus redirect aliases).
export function decodeTitleBucket(data) {
  const what = "title bucket";
  const bytes = toBytes(data);
  const [bucket, count] = readHeader(bytes, MAGIC_TITLES, what);
  const offsetsStart = HEADER_BYTES + count * 4;
  const flagsStart = offsetsStart + (count + 1) * 4;
  const titlesStart = flagsStart + count;
  if (bytes.length < titlesStart) {
    fail(what, "truncated arrays");
  }
  const ordinals = readU32Array(bytes, HEADER_BYTES, count);
  const titleOffsets = readU32Array(bytes, offsetsStart, count + 1);
  const flags = bytes.subarray(flagsStart, titlesStart);
  const titles = bytes.subarray(titlesStart);
  checkOffsets(titleOffsets, titles.length, what);
  for (let i = 1; i < count; i += 1) {
    const order = compareBytes(
      titles,
      titleOffsets[i - 1],
      titleOffsets[i],
      titles,
      titleOffsets[i],
      titleOffsets[i + 1],
    );
    if (order >= 0) {
      fail(what, `titles are not strictly ascending at entry ${i}`);
    }
  }

  return {
    bucket,
    count,
    byteLength: bytes.length,
    // Binary search for an exact title given as UTF-8 bytes.
    lookup(title) {
      let low = 0;
      let high = count;
      while (low < high) {
        const mid = low + ((high - low) >> 1);
        const order = compareBytes(
          titles,
          titleOffsets[mid],
          titleOffsets[mid + 1],
          title,
          0,
          title.length,
        );
        if (order < 0) {
          low = mid + 1;
        } else if (order > 0) {
          high = mid;
        } else {
          return {
            ordinal: ordinals[mid],
            isRedirect: (flags[mid] & TITLE_FLAG_REDIRECT) !== 0,
          };
        }
      }
      return null;
    },
    entry(index) {
      return {
        title: decoder.decode(titles.subarray(titleOffsets[index], titleOffsets[index + 1])),
        ordinal: ordinals[index],
        isRedirect: (flags[index] & TITLE_FLAG_REDIRECT) !== 0,
      };
    },
  };
}

// Byte length and SHA-256 of every shard of one kind, in shard order.
export function decodeShardIndex(data) {
  const what = "shard index";
  const bytes = toBytes(data);
  const [kind, count] = readHeader(bytes, MAGIC_INDEX, what);
  const expected = HEADER_BYTES + count * INDEX_ENTRY_BYTES;
  if (bytes.length !== expected) {
    fail(what, `expected ${expected} bytes for ${count} entries, found ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return {
    kind,
    count,
    entry(index) {
      if (!Number.isInteger(index) || index < 0 || index >= count) {
        throw new RangeError(`${what}: entry ${index} is out of range`);
      }
      const start = HEADER_BYTES + index * INDEX_ENTRY_BYTES;
      return {
        bytes: view.getUint32(start, true),
        sha256: bytes.subarray(start + 4, start + INDEX_ENTRY_BYTES),
      };
    },
  };
}

// Headerless little-endian u32 ordinal list, as used by the report files.
export function decodeOrdinalList(data) {
  const bytes = toBytes(data);
  if (bytes.length % 4 !== 0) {
    fail("ordinal list", "length is not a multiple of 4");
  }
  return readU32Array(bytes, 0, bytes.length / 4);
}

export function shardPath(dir, index) {
  return `${dir}/${String(index).padStart(6, "0")}.bin`;
}

export function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
