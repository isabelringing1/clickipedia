import { describe, expect, it } from "vitest";

import { LruCache } from "./lru.js";

describe("LruCache", () => {
  it("evicts the least recently used entry at the entry limit", () => {
    const cache = new LruCache({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("b")).toBe(false);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("evicts by weight", () => {
    const cache = new LruCache({ maxWeight: 10 });
    cache.set("a", "a", 4);
    cache.set("b", "b", 4);
    cache.set("c", "c", 4);
    expect(cache.has("a")).toBe(false);
    expect(cache.weight).toBe(8);
    cache.set("b", "b2", 9);
    expect(cache.has("c")).toBe(false);
    expect(cache.get("b")).toBe("b2");
    expect(cache.weight).toBe(9);
  });

  it("keeps a single entry heavier than the limit", () => {
    const cache = new LruCache({ maxWeight: 10 });
    cache.set("a", "a", 4);
    cache.set("huge", "huge", 50);
    expect(cache.has("a")).toBe(false);
    expect(cache.get("huge")).toBe("huge");
    cache.set("b", "b", 1);
    expect(cache.has("huge")).toBe(false);
    expect(cache.weight).toBe(1);
  });

  it("tracks weight through delete and clear", () => {
    const cache = new LruCache({ maxWeight: 100 });
    cache.set("a", 1, 30);
    cache.set("b", 2, 30);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.weight).toBe(30);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.weight).toBe(0);
    expect(cache.get("b")).toBeUndefined();
  });

  it("rejects limits that could never hold an entry", () => {
    expect(() => new LruCache({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new LruCache({ maxWeight: 0 })).toThrow(RangeError);
  });
});
