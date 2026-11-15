// A fixed-size set of small integers, one bit each.
//
// The game tracks which of Wikipedia's millions of articles have been opened;
// a bitset holds that in under a megabyte and saves as a single binary blob.

const WORD_BITS = 32;

function popcount(word) {
  word -= (word >>> 1) & 0x55555555;
  word = (word & 0x33333333) + ((word >>> 2) & 0x33333333);
  word = (word + (word >>> 4)) & 0x0f0f0f0f;
  return Math.imul(word, 0x01010101) >>> 24;
}

// Index of the lowest set bit of a nonzero word.
function lowestBit(word) {
  return 31 - Math.clz32(word & -word);
}

const SPARSE_CHUNK_WORDS = 256;

export function byteLengthFor(size) {
  return Math.ceil(size / 8);
}

export class Bitset {
  constructor(size) {
    if (!Number.isInteger(size) || size < 0 || size > 0xffffffff) {
      throw new RangeError(`invalid bitset size ${size}`);
    }
    this.size = size;
    this.words = new Uint32Array(Math.ceil(size / WORD_BITS));
    this.count = 0;
  }

  check(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) {
      throw new RangeError(`bit ${index} is outside a bitset of ${this.size}`);
    }
  }

  has(index) {
    this.check(index);
    return (this.words[index >>> 5] & (1 << (index & 31))) !== 0;
  }

  // Sets the bit and reports whether it was newly set.
  add(index) {
    this.check(index);
    const word = index >>> 5;
    const mask = 1 << (index & 31);
    if ((this.words[word] & mask) !== 0) {
      return false;
    }
    this.words[word] |= mask;
    this.count += 1;
    return true;
  }

  delete(index) {
    this.check(index);
    const word = index >>> 5;
    const mask = 1 << (index & 31);
    if ((this.words[word] & mask) === 0) {
      return false;
    }
    this.words[word] &= ~mask;
    this.count -= 1;
    return true;
  }

  // Removes every element that is not also in `other`.
  intersectWith(other) {
    if (other.size !== this.size) {
      throw new RangeError("bitsets differ in size");
    }
    let count = 0;
    for (let i = 0; i < this.words.length; i += 1) {
      this.words[i] &= other.words[i];
      count += popcount(this.words[i]);
    }
    this.count = count;
  }

  // Serializes to bytes where bit `i` is bit `i % 8` of byte `i >> 3`,
  // independent of the platform's byte order.
  toBytes() {
    const bytes = new Uint8Array(byteLengthFor(this.size));
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (this.words[i >>> 2] >>> ((i & 3) * 8)) & 0xff;
    }
    return bytes;
  }

  // Rebuilds a bitset, rejecting input of the wrong length or with bits set
  // beyond `size`. The count is recomputed rather than trusted.
  static fromBytes(size, data) {
    const bitset = new Bitset(size);
    const bytes =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : null;
    if (bytes === null) {
      throw new TypeError("bitset data must be a Uint8Array or ArrayBuffer");
    }
    if (bytes.length !== byteLengthFor(size)) {
      throw new RangeError(
        `bitset data is ${bytes.length} bytes, expected ${byteLengthFor(size)} for ${size} bits`,
      );
    }
    for (let i = 0; i < bytes.length; i += 1) {
      bitset.words[i >>> 2] |= bytes[i] << ((i & 3) * 8);
    }
    const tail = size % WORD_BITS;
    if (tail !== 0 && bitset.words[bitset.words.length - 1] >>> tail !== 0) {
      throw new RangeError("bitset data has bits set beyond its size");
    }
    let count = 0;
    for (let i = 0; i < bitset.words.length; i += 1) {
      count += popcount(bitset.words[i]);
    }
    bitset.count = count;
    return bitset;
  }
}

// A bitset that allocates 8,192-bit chunks only where a room has activity.
// New rooms therefore cost about 2 KiB (visited + expanded), not two full
// Wikipedia-sized arrays. Its public operations match Bitset.
export class SparseBitset {
  constructor(size) {
    if (!Number.isInteger(size) || size < 0 || size > 0xffffffff) {
      throw new RangeError(`invalid bitset size ${size}`);
    }
    this.size = size;
    this.count = 0;
    this.chunks = new Map();
  }

  check(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) {
      throw new RangeError(`bit ${index} is outside a bitset of ${this.size}`);
    }
  }

  wordAt(wordIndex) {
    const chunk = this.chunks.get(Math.floor(wordIndex / SPARSE_CHUNK_WORDS));
    return chunk?.[wordIndex % SPARSE_CHUNK_WORDS] ?? 0;
  }

  has(index) {
    this.check(index);
    return (this.wordAt(index >>> 5) & (1 << (index & 31))) !== 0;
  }

  add(index) {
    this.check(index);
    const wordIndex = index >>> 5;
    const chunkIndex = Math.floor(wordIndex / SPARSE_CHUNK_WORDS);
    let chunk = this.chunks.get(chunkIndex);
    if (!chunk) {
      chunk = new Uint32Array(SPARSE_CHUNK_WORDS);
      this.chunks.set(chunkIndex, chunk);
    }
    const localWord = wordIndex % SPARSE_CHUNK_WORDS;
    const mask = 1 << (index & 31);
    if ((chunk[localWord] & mask) !== 0) return false;
    chunk[localWord] |= mask;
    this.count += 1;
    return true;
  }

  intersectWith(other) {
    let count = 0;
    for (const [chunkIndex, chunk] of this.chunks) {
      let nonzero = false;
      for (let i = 0; i < chunk.length; i += 1) {
        const wordIndex = chunkIndex * SPARSE_CHUNK_WORDS + i;
        chunk[i] &= wordOf(other, wordIndex);
        nonzero ||= chunk[i] !== 0;
        count += popcount(chunk[i]);
      }
      if (!nonzero) this.chunks.delete(chunkIndex);
    }
    this.count = count;
  }

  toChunks() {
    return [...this.chunks.entries()].map(([index, words]) => ({
      index,
      bytes: new Uint8Array(words.buffer.slice(0)),
    }));
  }

  static fromChunks(size, entries) {
    if (!Array.isArray(entries)) {
      throw new TypeError("sparse bitset chunks must be an array");
    }
    const result = new SparseBitset(size);
    for (const entry of entries) {
      if (
        !entry ||
        !Number.isInteger(entry.index) ||
        entry.index < 0 ||
        entry.index * SPARSE_CHUNK_WORDS >= Math.ceil(size / WORD_BITS) ||
        result.chunks.has(entry.index)
      ) {
        throw new RangeError("sparse bitset has an invalid chunk index");
      }
      const bytes =
        entry.bytes instanceof Uint8Array
          ? entry.bytes
          : entry.bytes instanceof ArrayBuffer
            ? new Uint8Array(entry.bytes)
            : null;
      if (!bytes || bytes.byteLength !== SPARSE_CHUNK_WORDS * 4) {
        throw new RangeError("sparse bitset has an invalid chunk");
      }
      const words = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      let nonzero = false;
      for (let local = 0; local < words.length; local += 1) {
        const word = words[local];
        const wordIndex = entry.index * SPARSE_CHUNK_WORDS + local;
        const firstBit = wordIndex * WORD_BITS;
        if (firstBit >= size && word !== 0) {
          throw new RangeError("sparse bitset has bits beyond its size");
        }
        const remaining = size - firstBit;
        if (remaining > 0 && remaining < WORD_BITS && word >>> remaining !== 0) {
          throw new RangeError("sparse bitset has bits beyond its size");
        }
        nonzero ||= word !== 0;
        result.count += popcount(word);
      }
      if (nonzero) result.chunks.set(entry.index, words);
    }
    return result;
  }
}

function wordOf(bitset, wordIndex) {
  return typeof bitset.wordAt === "function"
    ? bitset.wordAt(wordIndex)
    : bitset.words[wordIndex] ?? 0;
}

// Finds the first index in [from, to) that is in `included` but not in
// `excluded`, or -1. Both bitsets must have the same size.
export function nextInDifference(included, excluded, from, to) {
  if (included.size !== excluded.size) {
    throw new RangeError("bitsets differ in size");
  }
  const end = Math.min(to, included.size);
  if (!(from >= 0) || from >= end) {
    return -1;
  }
  if (included.chunks instanceof Map) {
    const firstWord = from >>> 5;
    const lastWord = (end - 1) >>> 5;
    const firstChunk = Math.floor(firstWord / SPARSE_CHUNK_WORDS);
    const lastChunk = Math.floor(lastWord / SPARSE_CHUNK_WORDS);
    const chunks = [...included.chunks.keys()]
      .filter((chunk) => chunk >= firstChunk && chunk <= lastChunk)
      .sort((a, b) => a - b);
    for (const chunkIndex of chunks) {
      const chunkStart = chunkIndex * SPARSE_CHUNK_WORDS;
      const localStart = Math.max(0, firstWord - chunkStart);
      const localEnd = Math.min(SPARSE_CHUNK_WORDS - 1, lastWord - chunkStart);
      for (let local = localStart; local <= localEnd; local += 1) {
        const wordIndex = chunkStart + local;
        let word = included.wordAt(wordIndex) & ~wordOf(excluded, wordIndex);
        if (wordIndex === firstWord) {
          word &= 0xffffffff << (from & 31);
        }
        if (word !== 0) {
          const index = wordIndex * WORD_BITS + lowestBit(word);
          if (index < end) return index;
        }
      }
    }
    return -1;
  }
  let wordIndex = from >>> 5;
  const lastWord = (end - 1) >>> 5;
  // Mask off bits below `from` in the first word.
  let word =
    wordOf(included, wordIndex) &
    ~wordOf(excluded, wordIndex) &
    (0xffffffff << (from & 31));
  for (;;) {
    if (word !== 0) {
      const index = wordIndex * WORD_BITS + lowestBit(word);
      return index < end ? index : -1;
    }
    wordIndex += 1;
    if (wordIndex > lastWord) {
      return -1;
    }
    word = wordOf(included, wordIndex) & ~wordOf(excluded, wordIndex);
  }
}
