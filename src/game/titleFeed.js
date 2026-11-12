// Looks up titles for automatically opened articles so they can be shown.
//
// Automation knows articles only by ordinal; a title costs a metadata shard
// (about 100 KiB for English Wikipedia), and consecutive articles are rarely
// in the same shard. The feed keeps that cost bounded:
//
//   * a short queue: older entries are dropped when automation outruns it;
//   * a few lookups at a time, delivered in the order articles were opened;
//   * a download allowance: titles in shards that are already in memory are
//     free, the rest are rationed to `downloadsPerSecond`. Slow automation
//     shows every article; fast automation shows a sample.
//
// Articles that are dropped here are still opened and counted; they just do
// not appear in the history.

import { GraphError } from "../wikiGraph/client.js";

export class TitleFeed {
  constructor({
    lookup,
    onTitles,
    // Which shard holds an article's title, and whether it is in memory.
    // Without these every lookup is assumed to need a download.
    shardOf = (ordinal) => ordinal,
    isShardCached = () => false,
    now = () => performance.now(),
    maxPending = 20,
    batchSize = 4,
    maxPerPush = 4,
    downloadsPerSecond = 1,
    downloadBurst = 4,
    deliveryIntervalMs = 0,
    timers = globalThis,
  }) {
    this.lookup = lookup;
    this.onTitles = onTitles;
    this.shardOf = shardOf;
    this.isShardCached = isShardCached;
    this.now = now;
    this.maxPending = maxPending;
    this.batchSize = batchSize;
    this.maxPerPush = maxPerPush;
    this.downloadsPerSecond = downloadsPerSecond;
    this.downloadBurst = downloadBurst;
    this.deliveryIntervalMs = deliveryIntervalMs;
    this.timers = timers;
    this.allowance = downloadBurst;
    this.refilledAt = now();
    this.pending = [];
    this.ready = [];
    this.deliveryTimer = null;
    this.busy = false;
    this.stopped = false;
  }

  // Queues the most recent of the given ordinals for display.
  push(ordinals) {
    if (this.stopped) {
      return;
    }
    this.pending.push(...ordinals.slice(-this.maxPerPush));
    if (this.pending.length > this.maxPending) {
      this.pending.splice(0, this.pending.length - this.maxPending);
    }
    this.drain();
  }

  stop() {
    this.stopped = true;
    this.pending.length = 0;
    this.ready.length = 0;
    if (this.deliveryTimer !== null) {
      this.timers.clearTimeout(this.deliveryTimer);
      this.deliveryTimer = null;
    }
  }

  refill() {
    const time = this.now();
    const earned = ((time - this.refilledAt) / 1000) * this.downloadsPerSecond;
    this.allowance = Math.min(this.downloadBurst, this.allowance + Math.max(0, earned));
    this.refilledAt = time;
  }

  // Takes the next batch from the queue, dropping articles whose title would
  // need a download the allowance does not cover.
  takeBatch() {
    this.refill();
    const batch = [];
    const downloading = new Set();
    while (this.pending.length > 0 && batch.length < this.batchSize) {
      const ordinal = this.pending.shift();
      const shard = this.shardOf(ordinal);
      if (!this.isShardCached(shard) && !downloading.has(shard)) {
        if (this.allowance < 1) {
          continue;
        }
        this.allowance -= 1;
        downloading.add(shard);
      }
      batch.push(ordinal);
    }
    return batch;
  }

  async drain() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      while (this.pending.length > 0 && !this.stopped) {
        const batch = this.takeBatch();
        const results = await Promise.all(batch.map((ordinal) => this.resolve(ordinal)));
        const found = results.filter((result) => result !== null);
        if (found.length > 0 && !this.stopped) {
          this.queueForDisplay(found);
        }
      }
    } catch (error) {
      console.error("Could not look up article titles:", error);
    } finally {
      this.busy = false;
    }
  }

  // Network responses may arrive in a burst. Keep title lookup throughput
  // independent from presentation: production reveals one background window
  // at a steady cadence instead of mounting a whole batch in one frame.
  queueForDisplay(found) {
    if (this.deliveryIntervalMs <= 0) {
      this.onTitles(found);
      return;
    }
    this.ready.push(...found);
    if (this.ready.length > this.maxPending) {
      this.ready.splice(0, this.ready.length - this.maxPending);
    }
    this.scheduleDelivery();
  }

  scheduleDelivery() {
    if (this.stopped || this.deliveryTimer !== null || this.ready.length === 0) {
      return;
    }
    this.deliveryTimer = this.timers.setTimeout(() => {
      this.deliveryTimer = null;
      const next = this.ready.shift();
      if (!this.stopped && next !== undefined) {
        this.onTitles([next]);
      }
      this.scheduleDelivery();
    }, this.deliveryIntervalMs);
  }

  // A title that cannot be fetched is skipped: the history is a convenience
  // and must not block or break automation.
  async resolve(ordinal) {
    try {
      return { ordinal, title: await this.lookup(ordinal) };
    } catch (error) {
      if (error instanceof GraphError) {
        return null;
      }
      throw error;
    }
  }
}
