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
  let wordIndex = from >>> 5;
  const lastWord = (end - 1) >>> 5;
  // Mask off bits below `from` in the first word.
  let word =
    included.words[wordIndex] & ~excluded.words[wordIndex] & (0xffffffff << (from & 31));
  for (;;) {
    if (word !== 0) {
      const index = wordIndex * WORD_BITS + lowestBit(word);
      return index < end ? index : -1;
    }
    wordIndex += 1;
    if (wordIndex > lastWord) {
      return -1;
    }
    word = included.words[wordIndex] & ~excluded.words[wordIndex];
  }
}
