// A least-recently-used cache bounded by both entry count and total weight.
//
// Decoded shards are large, so the graph client bounds them by bytes; the
// entry limit is a second guard for kinds whose shards are tiny.
export class LruCache {
  constructor({ maxEntries = Infinity, maxWeight = Infinity } = {}) {
    if (!(maxEntries >= 1) || !(maxWeight > 0)) {
      throw new RangeError("LruCache limits must be positive");
    }
    this.maxEntries = maxEntries;
    this.maxWeight = maxWeight;
    this.weight = 0;
    // Map iteration order is insertion order, so the first key is the oldest.
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  has(key) {
    return this.entries.has(key);
  }

  get(key) {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  // The newest entry is always kept, even when it alone exceeds the weight
  // limit, so a caller never loses the value it just loaded.
  set(key, value, weight = 1) {
    this.delete(key);
    this.entries.set(key, { value, weight });
    this.weight += weight;
    while (
      this.entries.size > 1 &&
      (this.entries.size > this.maxEntries || this.weight > this.maxWeight)
    ) {
      this.delete(this.entries.keys().next().value);
    }
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return false;
    }
    this.entries.delete(key);
    this.weight -= entry.weight;
    return true;
  }

  clear() {
    this.entries.clear();
    this.weight = 0;
  }
}
