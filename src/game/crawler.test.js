import { beforeEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../save/playerStore.js";
import { NO_SOURCE, PRIORITY_LIMIT } from "../save/saveFormat.js";
import { BASE_URL, FakeBucket, expected, fastOptions } from "../testing/fixtureGraph.js";
import { GraphError } from "../wikiGraph/client.js";
import { startSession } from "./session.js";

const ROOT = `snapshots/${expected.snapshotId}/`;
const links = expected.articles.map((article) => article.links);

let bucket;

beforeEach(() => {
  bucket = new FakeBucket();
});

async function start(extra) {
  return startSession({
    baseUrl: BASE_URL,
    store: new MemoryStore(),
    graphOptions: fastOptions(bucket, extra),
  });
}

// Every article reachable from the start by following links, computed
// directly from the hand-written expectations.
function reachableFromStart() {
  const seen = new Set([expected.startArticle.ordinal]);
  const queue = [...seen];
  while (queue.length > 0) {
    for (const target of links[queue.shift()]) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

function visitedSet(session) {
  const out = new Set();
  for (let ordinal = 0; ordinal < session.articleCount; ordinal += 1) {
    if (session.hasVisited(ordinal)) {
      out.add(ordinal);
    }
  }
  return out;
}

describe("Crawler", () => {
  it("opens exactly the articles reachable from the start", async () => {
    const session = await start();
    const opened = [];
    for (;;) {
      const result = await session.crawler.run(1);
      opened.push(...result.opened);
      if (result.exhausted) {
        break;
      }
    }
    expect(visitedSet(session)).toEqual(reachableFromStart());
    expect(session.visitedCount).toBe(expected.connectivity.reachableFromStart);
    // Each article is opened once, and the start article is never re-opened.
    expect(new Set(opened).size).toBe(opened.length);
    expect(opened.length).toBe(expected.connectivity.reachableFromStart - 1);
    expect(opened).not.toContain(expected.startArticle.ordinal);
    // Everything opened has had its links followed.
    expect(session.state.expanded.count).toBe(session.visitedCount);
  });

  it("only opens articles through links that exist in the graph", async () => {
    const session = await start();
    for (;;) {
      const before = visitedSet(session);
      const bot = { ...session.state.automation.bots[0] };
      const { opened, exhausted } = await session.crawler.run(1);
      for (const target of opened) {
        expect(before.has(target)).toBe(false);
        const sources = [...before].filter((source) => links[source].includes(target));
        expect(sources.length, `a visited article links to ${target}`).toBeGreaterThan(0);
        if (bot.source !== NO_SOURCE) {
          expect(links[bot.source]).toContain(target);
        }
      }
      if (exhausted) {
        break;
      }
    }
  });

  it("respects the budget and resumes mid-article", async () => {
    const session = await start();
    const first = await session.crawler.run(2);
    expect(first).toEqual({ opened: [1, 2], exhausted: false });
    expect(session.state.automation.bots[0]).toEqual({ source: 0, cursor: 2 });
    expect(session.state.expanded.has(0)).toBe(false);

    const second = await session.crawler.run(1);
    expect(second.opened).toEqual([4]);
    expect(session.state.automation.bots[0]).toEqual({ source: NO_SOURCE, cursor: 0 });
    expect(session.state.expanded.has(0)).toBe(true);
  });

  it("opens nothing with no budget", async () => {
    const session = await start();
    expect(await session.crawler.run(0)).toEqual({ opened: [], exhausted: false });
    expect(session.visitedCount).toBe(1);
  });

  it("reports exhaustion and stays exhausted until something new is opened", async () => {
    const session = await start();
    expect((await session.crawler.run(100)).exhausted).toBe(true);
    expect(await session.crawler.run(100)).toEqual({ opened: [], exhausted: true });

    // Twin A is unreachable by links; opening it by hand gives the crawler
    // one more article to find.
    await session.openLink("Twin A", 0);
    expect(await session.crawler.run(100)).toEqual({ opened: [9], exhausted: true });
  });

  it("follows hand-opened articles before sweeping", async () => {
    const session = await start();
    await session.openLink("Twin A", 0);
    await session.openLink("Back\\slash", 0);
    const { opened } = await session.crawler.run(2);
    // Twin A (8) links to Twin B (9); Back\slash (3) links to Café (4).
    expect(opened).toEqual([9, 4]);
    expect(session.state.automation.priority).toEqual([]);
  });

  it("bounds the priority queue without losing articles", async () => {
    const session = await start();
    for (let i = 0; i < PRIORITY_LIMIT + 50; i += 1) {
      session.crawler.prioritize(i % 2 === 0 ? 8 : 5);
    }
    expect(session.state.automation.priority.length).toBe(PRIORITY_LIMIT);
    // Entries that are not pending are skipped rather than followed.
    const { exhausted } = await session.crawler.run(100, { timeSliceMs: Infinity });
    expect(exhausted).toBe(true);
    expect(visitedSet(session)).toEqual(reachableFromStart());
  });

  it("prefers pending articles in the shard it already has", async () => {
    const session = await start();
    // Open one article in each adjacency shard (shards hold 4 articles).
    await session.openLink("Twin A", 0);
    session.state.automation.priority.length = 0;
    await session.crawler.run(100);
    const paths = bucket.requests
      .map((request) => request.path)
      .filter((path) => /adjacency\/\d+\.bin$/.test(path));
    // Three shards exist; each is fetched once despite the back-and-forth
    // links between them.
    expect(paths.sort()).toEqual([
      `${ROOT}adjacency/000000.bin`,
      `${ROOT}adjacency/000001.bin`,
      `${ROOT}adjacency/000002.bin`,
    ]);
  });

  it("wraps its sweep around the end of the ordinal range", async () => {
    const session = await start();
    await session.crawler.run(100);
    session.state.automation.scanCursor = 9;
    session.crawler.currentShard = -1;
    session.state.visited.add(5);
    const { opened, exhausted } = await session.crawler.run(100);
    // Orphan (5) links only to Cookie Clicker, which is already open.
    expect(opened).toEqual([]);
    expect(exhausted).toBe(true);
    expect(session.state.expanded.has(5)).toBe(true);
  });

  it("yields when its time slice is used up", async () => {
    const session = await start();
    let clock = 0;
    session.crawler.now = () => (clock += 10);
    const { opened, exhausted } = await session.crawler.run(100, { timeSliceMs: 8 });
    // The clock advances 10 ms per reading, so the slice ends after one source.
    expect(opened).toEqual([1, 2, 4]);
    expect(exhausted).toBe(false);
  });

  it("keeps its place when the graph is unreachable", async () => {
    const session = await start({ retries: 0 });
    await session.crawler.run(1);
    const before = structuredClone(session.state.automation);
    bucket.offline = true;
    session.graph.caches.adjacency.clear();

    const error = await session.crawler.run(5).catch((caught) => caught);
    expect(error).toBeInstanceOf(GraphError);
    expect(error.opened).toEqual([]);
    expect(session.state.automation).toEqual(before);
    expect(session.visitedCount).toBe(2);

    bucket.offline = false;
    expect((await session.crawler.run(5)).opened).toEqual([2, 4, 3, 7]);
  });

  it("reports articles opened before a failure", async () => {
    const session = await start({ retries: 0 });
    bucket.files.delete(`${ROOT}adjacency/000001.bin`);
    // Shard 0 loads; following Café (4) needs the missing shard 1.
    const error = await session.crawler.run(100).catch((caught) => caught);
    expect(error).toBeInstanceOf(GraphError);
    expect(error.opened.length).toBeGreaterThan(0);
    expect(session.visitedCount).toBe(1 + error.opened.length);
  });

  it("never requests anything but graph shards", async () => {
    const session = await start();
    await session.crawler.run(1000);
    expect(bucket.requests.length).toBeGreaterThan(0);
    for (const { path } of bucket.requests) {
      expect(path === "latest.json" || path.startsWith(ROOT), path).toBe(true);
      expect(path).not.toMatch(/metadata|titles/);
    }
  });
});
