import { describe, expect, it, vi } from "vitest";

import { GraphError } from "../wikiGraph/client.js";
import { TitleFeed } from "./titleFeed.js";

// A lookup whose answers are released by hand, to control interleaving.
function manualLookup() {
  const waiting = [];
  const lookup = vi.fn(
    (ordinal) => new Promise((resolve, reject) => waiting.push({ ordinal, resolve, reject })),
  );
  const settle = async (count = waiting.length) => {
    for (const { ordinal, resolve } of waiting.splice(0, count)) {
      resolve(`Title_${ordinal}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { lookup, waiting, settle };
}

// Lifts the download allowance for tests about ordering and queueing.
const unlimited = { downloadBurst: 1000 };

describe("TitleFeed", () => {
  it("delivers titles in the order the articles were opened", async () => {
    const delivered = [];
    const feed = new TitleFeed({
      lookup: async (ordinal) => {
        // Later ordinals answer sooner.
        await new Promise((resolve) => setTimeout(resolve, 10 - ordinal));
        return `Title_${ordinal}`;
      },
      onTitles: (titles) => delivered.push(...titles),
      batchSize: 2,
      ...unlimited,
    });
    feed.push([1, 2]);
    feed.push([3]);
    await vi.waitFor(() => expect(delivered.length).toBe(3));
    expect(delivered).toEqual([
      { ordinal: 1, title: "Title_1" },
      { ordinal: 2, title: "Title_2" },
      { ordinal: 3, title: "Title_3" },
    ]);
  });

  it("limits concurrent lookups to one batch", async () => {
    const { lookup, settle } = manualLookup();
    const onTitles = vi.fn();
    const feed = new TitleFeed({ lookup, onTitles, batchSize: 2, maxPerPush: 10, ...unlimited });
    feed.push([1, 2, 3, 4, 5]);
    expect(lookup).toHaveBeenCalledTimes(2);
    await settle();
    expect(lookup).toHaveBeenCalledTimes(4);
    await settle();
    await settle();
    expect(lookup).toHaveBeenCalledTimes(5);
    expect(onTitles).toHaveBeenCalledTimes(3);
  });

  it("keeps only the newest articles when automation outruns the network", async () => {
    const { lookup, settle } = manualLookup();
    const delivered = [];
    const feed = new TitleFeed({
      lookup,
      onTitles: (titles) => delivered.push(...titles.map((entry) => entry.ordinal)),
      maxPending: 3,
      batchSize: 1,
      maxPerPush: 2,
    });
    // Only the last two of a large turn are considered at all.
    feed.push([10, 11, 12, 13]);
    expect(lookup.mock.calls).toEqual([[12]]);
    for (let ordinal = 20; ordinal < 30; ordinal += 1) {
      feed.push([ordinal]);
    }
    expect(feed.pending).toEqual([27, 28, 29]);
    for (let i = 0; i < 6; i += 1) {
      await settle();
    }
    expect(delivered).toEqual([12, 27, 28, 29]);
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("skips titles the graph cannot provide and keeps going", async () => {
    const delivered = [];
    const feed = new TitleFeed({
      lookup: async (ordinal) => {
        if (ordinal === 2) {
          throw new GraphError("network", "offline");
        }
        return `Title_${ordinal}`;
      },
      onTitles: (titles) => delivered.push(...titles.map((entry) => entry.ordinal)),
      ...unlimited,
    });
    feed.push([1, 2, 3]);
    await vi.waitFor(() => expect(delivered).toEqual([1, 3]));
    feed.push([2]);
    feed.push([4]);
    await vi.waitFor(() => expect(delivered).toEqual([1, 3, 4]));
  });

  it("survives an unexpected lookup error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const delivered = [];
    let fail = true;
    const feed = new TitleFeed({
      lookup: async (ordinal) => {
        if (fail) {
          throw new TypeError("bug");
        }
        return `Title_${ordinal}`;
      },
      onTitles: (titles) => delivered.push(...titles.map((entry) => entry.ordinal)),
    });
    feed.push([1]);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    await vi.waitFor(() => expect(feed.busy).toBe(false));
    fail = false;
    feed.push([2]);
    await vi.waitFor(() => expect(delivered).toEqual([2]));
    error.mockRestore();
  });

  it("delivers nothing after it is stopped", async () => {
    const { lookup, settle } = manualLookup();
    const onTitles = vi.fn();
    const feed = new TitleFeed({ lookup, onTitles });
    feed.push([1, 2]);
    feed.stop();
    await settle();
    feed.push([3]);
    await settle();
    expect(onTitles).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("paces visible windows one at a time after a lookup burst", async () => {
    const scheduled = [];
    const timers = {
      setTimeout: (callback, delay) => {
        scheduled.push({ callback, delay, cleared: false });
        return scheduled.length - 1;
      },
      clearTimeout: (id) => {
        scheduled[id].cleared = true;
      },
    };
    const delivered = [];
    const feed = new TitleFeed({
      lookup: async (ordinal) => `Title_${ordinal}`,
      onTitles: (titles) => delivered.push(...titles.map((entry) => entry.ordinal)),
      deliveryIntervalMs: 400,
      timers,
      ...unlimited,
    });

    feed.push([1, 2, 3]);
    await vi.waitFor(() => expect(feed.ready).toHaveLength(3));
    expect(delivered).toEqual([]);
    expect(scheduled[0].delay).toBe(400);

    scheduled[0].callback();
    expect(delivered).toEqual([1]);
    expect(scheduled[1].delay).toBe(400);
    scheduled[1].callback();
    expect(delivered).toEqual([1, 2]);
    scheduled[2].callback();
    expect(delivered).toEqual([1, 2, 3]);
  });

  it("cancels paced windows when stopped", async () => {
    const scheduled = [];
    const timers = {
      setTimeout: (callback) => {
        scheduled.push({ callback, cleared: false });
        return scheduled.length - 1;
      },
      clearTimeout: (id) => {
        scheduled[id].cleared = true;
      },
    };
    const onTitles = vi.fn();
    const feed = new TitleFeed({
      lookup: async (ordinal) => `Title_${ordinal}`,
      onTitles,
      deliveryIntervalMs: 400,
      timers,
      ...unlimited,
    });
    feed.push([1]);
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    feed.stop();
    expect(scheduled[0].cleared).toBe(true);
    scheduled[0].callback();
    expect(onTitles).not.toHaveBeenCalled();
  });

  describe("download allowance", () => {
    function rationed(extra = {}) {
      const clock = { time: 0 };
      const cached = new Set();
      const delivered = [];
      const lookup = vi.fn(async (ordinal) => {
        // Looking a title up brings its shard into memory.
        cached.add(Math.floor(ordinal / 10));
        return `Title_${ordinal}`;
      });
      const feed = new TitleFeed({
        lookup,
        onTitles: (titles) => delivered.push(...titles.map((entry) => entry.ordinal)),
        shardOf: (ordinal) => Math.floor(ordinal / 10),
        isShardCached: (shard) => cached.has(shard),
        now: () => clock.time,
        maxPerPush: 10,
        maxPending: 50,
        downloadsPerSecond: 1,
        downloadBurst: 2,
        ...extra,
      });
      const idle = () => vi.waitFor(() => expect(feed.busy).toBe(false));
      return { clock, cached, delivered, lookup, feed, idle };
    }

    it("drops titles that would need more downloads than allowed", async () => {
      const { delivered, lookup, feed, idle } = rationed();
      // Five articles in five different shards; the allowance covers two.
      feed.push([5, 15, 25, 35, 45]);
      await idle();
      expect(delivered).toEqual([5, 15]);
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    it("does not charge for shards that are already in memory", async () => {
      const { cached, delivered, feed, idle } = rationed();
      cached.add(0);
      cached.add(7);
      feed.push([1, 71, 2, 72, 3, 73, 4, 74]);
      await idle();
      expect(delivered).toEqual([1, 71, 2, 72, 3, 73, 4, 74]);
      expect(feed.allowance).toBe(2);
    });

    it("charges once for several titles in the same new shard", async () => {
      const { delivered, feed, idle } = rationed({ downloadBurst: 1, batchSize: 4 });
      feed.push([30, 31, 32, 99]);
      await idle();
      expect(delivered).toEqual([30, 31, 32]);
    });

    it("earns downloads back over time, up to the burst", async () => {
      const { clock, delivered, feed, idle } = rationed();
      feed.push([5, 15, 25]);
      await idle();
      expect(delivered).toEqual([5, 15]);

      clock.time += 500;
      feed.push([35]);
      await idle();
      expect(delivered).toEqual([5, 15]);

      clock.time += 500;
      feed.push([45]);
      await idle();
      expect(delivered).toEqual([5, 15, 45]);

      // A long pause does not bank more than the burst.
      clock.time += 3_600_000;
      feed.push([55, 65, 75, 85]);
      await idle();
      expect(delivered).toEqual([5, 15, 45, 55, 65]);
    });

    it("shows every article when automation is slow", async () => {
      const { clock, delivered, feed, idle } = rationed();
      // One auto opener: an article every five seconds, each in a new shard.
      const opened = [];
      for (let i = 0; i < 20; i += 1) {
        clock.time += 5000;
        opened.push(i * 10 + 3);
        feed.push([i * 10 + 3]);
        await idle();
      }
      expect(delivered).toEqual(opened);
    });
  });
});
