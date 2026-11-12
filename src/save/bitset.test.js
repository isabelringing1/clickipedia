import { describe, expect, it } from "vitest";

import { Bitset, byteLengthFor, nextInDifference } from "./bitset.js";

describe("Bitset", () => {
  it("adds, tests, and counts members", () => {
    const bits = new Bitset(100);
    expect(bits.count).toBe(0);
    expect(bits.add(5)).toBe(true);
    expect(bits.add(5)).toBe(false);
    expect(bits.has(5)).toBe(true);
    expect(bits.has(6)).toBe(false);
    expect(bits.count).toBe(1);
    expect(bits.delete(5)).toBe(true);
    expect(bits.delete(5)).toBe(false);
    expect(bits.count).toBe(0);
  });

  it("handles word boundaries, including the sign bit", () => {
    const bits = new Bitset(130);
    const members = [0, 1, 30, 31, 32, 33, 62, 63, 64, 65, 127, 128, 129];
    for (const index of members) {
      expect(bits.add(index), `add ${index}`).toBe(true);
    }
    expect(bits.count).toBe(members.length);
    for (let index = 0; index < 130; index += 1) {
      expect(bits.has(index), `has ${index}`).toBe(members.includes(index));
    }
    // Bit 31 sets the sign bit of a 32-bit word; it must not leak.
    expect(bits.delete(31)).toBe(true);
    expect(bits.has(30)).toBe(true);
    expect(bits.has(32)).toBe(true);
    expect(bits.count).toBe(members.length - 1);
  });

  it("rejects indexes outside its size", () => {
    const bits = new Bitset(33);
    expect(bits.add(32)).toBe(true);
    for (const index of [-1, 33, 64, 1.5, NaN, "1", undefined, 2 ** 32]) {
      expect(() => bits.has(index), `has ${index}`).toThrow(RangeError);
      expect(() => bits.add(index), `add ${index}`).toThrow(RangeError);
      expect(() => bits.delete(index), `delete ${index}`).toThrow(RangeError);
    }
    expect(bits.count).toBe(1);
  });

  it("supports sizes that are not a multiple of 8 or 32, and empty sets", () => {
    for (const size of [0, 1, 7, 8, 9, 31, 32, 33, 63, 64, 65, 1000]) {
      const bits = new Bitset(size);
      expect(bits.toBytes().length).toBe(byteLengthFor(size));
      if (size > 0) {
        bits.add(size - 1);
        bits.add(0);
        expect(bits.has(size - 1)).toBe(true);
        expect(() => bits.has(size)).toThrow(RangeError);
      }
      const copy = Bitset.fromBytes(size, bits.toBytes());
      expect(copy.count).toBe(bits.count);
      expect([...copy.words]).toEqual([...bits.words]);
    }
    expect(() => new Bitset(-1)).toThrow(RangeError);
    expect(() => new Bitset(1.5)).toThrow(RangeError);
  });

  it("serializes bit i as bit i % 8 of byte i >> 3", () => {
    const bits = new Bitset(40);
    for (const index of [0, 9, 23, 31, 39]) {
      bits.add(index);
    }
    expect([...bits.toBytes()]).toEqual([0x01, 0x02, 0x80, 0x80, 0x80]);
    const copy = Bitset.fromBytes(40, new Uint8Array([0x01, 0x02, 0x80, 0x80, 0x80]));
    expect(copy.count).toBe(5);
    expect(copy.has(31)).toBe(true);
    expect(copy.has(39)).toBe(true);
    expect(copy.has(38)).toBe(false);
  });

  it("recounts on load and rejects malformed data", () => {
    const full = Bitset.fromBytes(12, new Uint8Array([0xff, 0x0f]));
    expect(full.count).toBe(12);
    expect(Bitset.fromBytes(12, new Uint8Array([0xff, 0x0f]).buffer).count).toBe(12);
    // A bit beyond the declared size.
    expect(() => Bitset.fromBytes(12, new Uint8Array([0xff, 0x1f]))).toThrow(RangeError);
    expect(() => Bitset.fromBytes(12, new Uint8Array(1))).toThrow(RangeError);
    expect(() => Bitset.fromBytes(12, new Uint8Array(3))).toThrow(RangeError);
    expect(() => Bitset.fromBytes(12, [0xff, 0x0f])).toThrow(TypeError);
    expect(() => Bitset.fromBytes(12, "abc")).toThrow(TypeError);
  });

  it("round-trips a large random set", () => {
    const size = 7_000_003;
    const bits = new Bitset(size);
    let seed = 12345;
    const members = new Set();
    for (let i = 0; i < 20000; i += 1) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      members.add(seed % size);
    }
    for (const index of members) {
      bits.add(index);
    }
    bits.add(size - 1);
    members.add(size - 1);
    const copy = Bitset.fromBytes(size, bits.toBytes());
    expect(copy.count).toBe(members.size);
    for (const index of members) {
      expect(copy.has(index)).toBe(true);
    }
  });

  it("intersects in place and recounts", () => {
    const a = new Bitset(70);
    const b = new Bitset(70);
    [1, 31, 32, 69].forEach((index) => a.add(index));
    [31, 33, 69].forEach((index) => b.add(index));
    a.intersectWith(b);
    expect(a.count).toBe(2);
    expect(a.has(31) && a.has(69)).toBe(true);
    expect(a.has(1) || a.has(32)).toBe(false);
    expect(() => a.intersectWith(new Bitset(71))).toThrow(RangeError);
  });
});

describe("nextInDifference", () => {
  function sets(size, included, excluded) {
    const a = new Bitset(size);
    const b = new Bitset(size);
    included.forEach((index) => a.add(index));
    excluded.forEach((index) => b.add(index));
    return [a, b];
  }

  it("finds members of the first set that are not in the second", () => {
    const [a, b] = sets(200, [3, 40, 64, 65, 199], [40, 64]);
    expect(nextInDifference(a, b, 0, 200)).toBe(3);
    expect(nextInDifference(a, b, 3, 200)).toBe(3);
    expect(nextInDifference(a, b, 4, 200)).toBe(65);
    expect(nextInDifference(a, b, 66, 200)).toBe(199);
    expect(nextInDifference(a, b, 199, 200)).toBe(199);
  });

  it("respects both ends of the range", () => {
    const [a, b] = sets(200, [31, 32, 95, 96], []);
    expect(nextInDifference(a, b, 32, 96)).toBe(32);
    expect(nextInDifference(a, b, 33, 95)).toBe(-1);
    expect(nextInDifference(a, b, 33, 96)).toBe(95);
    expect(nextInDifference(a, b, 96, 96)).toBe(-1);
    expect(nextInDifference(a, b, 97, 200)).toBe(-1);
    expect(nextInDifference(a, b, 97, 5000)).toBe(-1);
    expect(nextInDifference(a, b, 50, 40)).toBe(-1);
    expect(nextInDifference(a, b, 200, 200)).toBe(-1);
  });

  it("agrees with a straightforward scan", () => {
    const size = 333;
    const a = new Bitset(size);
    const b = new Bitset(size);
    let seed = 7;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 120; i += 1) {
      a.add(random() % size);
      b.add(random() % size);
    }
    for (let trial = 0; trial < 500; trial += 1) {
      const from = random() % (size + 1);
      const to = random() % (size + 2);
      let wanted = -1;
      for (let index = from; index < Math.min(to, size); index += 1) {
        if (a.has(index) && !b.has(index)) {
          wanted = index;
          break;
        }
      }
      expect(nextInDifference(a, b, from, to), `[${from}, ${to})`).toBe(wanted);
    }
  });

  it("requires equal sizes", () => {
    expect(() => nextInDifference(new Bitset(8), new Bitset(9), 0, 8)).toThrow(RangeError);
  });
});
