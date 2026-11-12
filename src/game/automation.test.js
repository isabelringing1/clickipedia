import { beforeEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../save/playerStore.js";
import { BASE_URL, FakeBucket, expected, fastOptions } from "../testing/fixtureGraph.js";
import {
  AutomationRunner,
  MAX_BACKLOG_SECONDS,
  MAX_ELAPSED_MS,
  MAX_OPENS_PER_BATCH,
  MAX_TURN_MS,
  TURN_INTERVAL_MS,
  accrueCredit,
  articlesPerSecond,
} from "./automation.js";
import { startSession } from "./session.js";

let bucket;

beforeEach(() => {
  bucket = new FakeBucket();
});

// A runner driven by a hand-advanced clock instead of real timers.
async function setup({ autos = 5, extra } = {}) {
  const session = await startSession({
    baseUrl: BASE_URL,
    store: new MemoryStore(),
    graphOptions: fastOptions(bucket, extra),
  });
  const clock = { now: 0 };
  session.crawler.now = () => clock.now;
  const events = { opened: [], statuses: [] };
  const state = { autos };
  const runner = new AutomationRunner({
    crawler: session.crawler,
    automation: session.state.automation,
    getAutos: () => state.autos,
    onOpened: (ordinals) => events.opened.push(ordinals),
    onStatus: (status) => events.statuses.push(status),
    now: () => clock.now,
  });
  runner.lastTurnAt = 0;
  const advance = async (ms) => {
    clock.now += ms;
    return runner.turn();
  };
  return { session, runner, clock, events, state, advance };
}

describe("accrueCredit", () => {
  it("earns one article per auto-opener every five seconds", () => {
    expect(articlesPerSecond(1)).toBeCloseTo(0.2);
    expect(articlesPerSecond(25)).toBe(5);
    expect(accrueCredit(0, 5000, 1)).toBeCloseTo(1);
    expect(accrueCredit(0.5, 1000, 25)).toBeCloseTo(5.5);
    expect(accrueCredit(0, 100, 25)).toBeCloseTo(0.5);
  });

  it("earns nothing without auto-openers and drops leftover credit", () => {
    expect(accrueCredit(0, 60000, 0)).toBe(0);
    expect(accrueCredit(3.5, 1000, 0)).toBe(0);
  });

  it("caps the time credited for one gap", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(accrueCredit(0, day, 5)).toBeCloseTo((MAX_ELAPSED_MS / 1000) * 1);
    expect(accrueCredit(0, -500, 5)).toBe(0);
  });

  it("caps the backlog", () => {
    const cap = articlesPerSecond(10) * MAX_BACKLOG_SECONDS;
    expect(accrueCredit(cap - 1, 60000, 10)).toBe(cap);
    // A single slow auto-opener can still save up for one article.
    expect(accrueCredit(0.9, 5000, 1)).toBeGreaterThanOrEqual(1);
  });
});

describe("AutomationRunner", () => {
  it("opens nothing without auto-openers", async () => {
    const { advance, session, events } = await setup({ autos: 0 });
    expect(await advance(60000)).toEqual([]);
    expect(session.visitedCount).toBe(1);
    expect(events.opened).toEqual([]);
  });

  it("opens articles at the purchased rate", async () => {
    // One auto-opener: an article every five seconds.
    const { advance, session } = await setup({ autos: 1 });
    for (let i = 0; i < 49; i += 1) {
      expect(await advance(100)).toEqual([]);
    }
    expect(await advance(100)).toEqual([1]);
    expect(session.visitedCount).toBe(2);
    for (let i = 0; i < 49; i += 1) {
      await advance(100);
    }
    expect(session.visitedCount).toBe(2);
    expect(await advance(100)).toEqual([2]);
  });

  it("carries fractions of an article between turns", async () => {
    // Five auto-openers: one article a second, in tenths per turn.
    const { advance, session } = await setup({ autos: 5 });
    let opened = 0;
    for (let i = 0; i < 30; i += 1) {
      opened += (await advance(100)).length;
      // No time is lost or invented: articles opened plus unspent credit
      // always equals the time elapsed at one article a second.
      expect(opened + session.state.automation.credit).toBeCloseTo((i + 1) / 10, 9);
      expect(session.state.automation.credit).toBeLessThan(1 + 1e-9);
    }
    // Tenths do not add up exactly in binary, so the third article may land
    // one turn late, but never earlier than its time.
    opened += (await advance(100)).length;
    expect(opened).toBe(3);
  });

  it("batches a long gap into one turn", async () => {
    const { advance, session, events } = await setup({ autos: 5 });
    const opened = await advance(4000);
    expect(opened.length).toBe(4);
    expect(events.opened).toEqual([opened]);
    expect(session.visitedCount).toBe(5);
  });

  it("catches up on throttled timers without exceeding the rate", async () => {
    // A hidden tab might run one turn a minute. One auto-opener earns 12
    // articles in that minute; only 5 others are reachable in the fixture.
    const { advance, session, events } = await setup({ autos: 1 });
    await advance(60000);
    expect(session.visitedCount).toBe(expected.connectivity.reachableFromStart);
    expect(events.statuses).toEqual(["idle"]);
  });

  describe("with a large backlog", () => {
    // Replaces the crawler with one that opens whatever it is asked to (or
    // `perBatch` articles) and takes `batchMs` to do it.
    async function backlog({ credit, perBatch = Infinity, batchMs = 0 }) {
      const context = await setup({ autos: 10 });
      const { runner, session, clock } = context;
      const budgets = [];
      let next = 100;
      session.crawler.run = async (budget) => {
        budgets.push(budget);
        clock.now += batchMs;
        const count = Math.min(budget, perBatch);
        const opened = Array.from({ length: count }, () => next++);
        return { opened, exhausted: false };
      };
      let pauses = 0;
      runner.pause = async () => {
        pauses += 1;
      };
      session.state.automation.credit = credit;
      // Keep the rate high enough that the backlog cap does not interfere.
      runner.getAutos = () => 1_000_000;
      return { ...context, budgets, pauses: () => pauses };
    }

    it("spends it in bounded batches, pausing between them", async () => {
      const { runner, session, budgets, pauses, events } = await backlog({
        credit: MAX_OPENS_PER_BATCH * 2 + 1234,
      });
      const opened = await runner.turn();
      expect(budgets).toEqual([MAX_OPENS_PER_BATCH, MAX_OPENS_PER_BATCH, 1234]);
      expect(pauses()).toBe(2);
      expect(opened.length).toBe(MAX_OPENS_PER_BATCH * 2 + 1234);
      expect(session.state.automation.credit).toBeLessThan(1);
      // No time passed, so everything is reported once.
      expect(events.opened).toEqual([opened]);
    });

    it("catches up on a minute of throttled time in one turn", async () => {
      // A hidden tab: one timer a minute. 2,500 auto-openers earn 30,000
      // articles in that minute, and none of them are forfeited.
      const { runner, session, clock } = await backlog({ credit: 0 });
      runner.getAutos = () => 2500;
      clock.now += 60_000;
      const opened = await runner.turn();
      expect(opened.length).toBe(30_000);
      expect(session.state.automation.credit).toBeLessThan(1);
    });

    it("ends a turn after its time limit and carries the rest over", async () => {
      const { runner, session, budgets } = await backlog({
        credit: 1000,
        perBatch: 10,
        batchMs: MAX_TURN_MS / 4,
      });
      const opened = await runner.turn();
      expect(budgets.length).toBe(4);
      expect(opened.length).toBe(40);
      expect(session.state.automation.credit).toBeCloseTo(960);

      // The next turn continues with what was left.
      const more = await runner.turn();
      expect(more.length).toBe(40);
    });

    it("reports progress during a long turn", async () => {
      const { runner, events } = await backlog({
        credit: 60,
        perBatch: 10,
        batchMs: TURN_INTERVAL_MS / 2,
      });
      const opened = await runner.turn();
      expect(opened.length).toBe(60);
      // Batches take 50 ms; a report goes out every 100 ms and at the end.
      expect(events.opened.map((batch) => batch.length)).toEqual([20, 20, 20]);
      expect(events.opened.flat()).toEqual(opened);
    });

    it("keeps going when a batch opens nothing", async () => {
      // Late in a game most links lead to articles that are already open.
      const { runner, session, budgets } = await backlog({
        credit: 50,
        perBatch: 0,
        batchMs: MAX_TURN_MS / 10,
      });
      expect(await runner.turn()).toEqual([]);
      expect(budgets.length).toBe(10);
      expect(session.state.automation.credit).toBeCloseTo(50);
    });

    it("stops between batches when the runner is stopped", async () => {
      const { runner, budgets, session } = await backlog({ credit: 100, perBatch: 10 });
      runner.pause = async () => {
        runner.stop();
      };
      const opened = await runner.turn();
      expect(opened.length).toBe(10);
      expect(budgets.length).toBe(1);
      expect(session.state.automation.credit).toBeCloseTo(90);
    });
  });

  it("does not bank credit once nothing is left to open", async () => {
    const { advance, session, events } = await setup({ autos: 25 });
    await advance(10000);
    expect(session.visitedCount).toBe(expected.connectivity.reachableFromStart);
    expect(session.state.automation.credit).toBe(0);
    expect(events.statuses).toEqual(["idle"]);

    // Later the player opens an unreachable article by hand; the crawler
    // picks it up at the normal rate rather than with a saved-up burst.
    await session.openLink("Twin A", 0);
    expect(await advance(100)).toEqual([]);
    expect(await advance(100)).toEqual([9]);
  });

  it("runs one turn at a time", async () => {
    const { runner, clock, session } = await setup({ autos: 25 });
    clock.now += 1000;
    const [first, second] = await Promise.all([runner.turn(), runner.turn()]);
    expect(first.length + second.length).toBe(5);
    expect(second).toEqual([]);
    expect(session.visitedCount).toBe(6);
  });

  it("backs off while the graph is unreachable and recovers", async () => {
    const { advance, session, events } = await setup({ autos: 5, extra: { retries: 0 } });
    bucket.offline = true;
    expect(await advance(1000)).toEqual([]);
    expect(events.statuses).toEqual(["offline"]);
    const attempts = bucket.requests.length;

    // Within the back-off window nothing is requested.
    await advance(500);
    expect(bucket.requests.length).toBe(attempts);

    // After it, one more attempt is made and the wait doubles.
    await advance(600);
    expect(bucket.requests.length).toBe(attempts + 1);
    await advance(1500);
    expect(bucket.requests.length).toBe(attempts + 1);

    bucket.offline = false;
    const opened = await advance(1000);
    expect(opened.length).toBeGreaterThan(0);
    expect(events.statuses).toEqual(["offline", "running"]);
    expect(session.visitedCount).toBe(1 + opened.length);
  });

  it("keeps earned credit through an outage, up to the cap", async () => {
    const { advance, session } = await setup({ autos: 5, extra: { retries: 0 } });
    bucket.offline = true;
    await advance(3000);
    expect(session.state.automation.credit).toBeCloseTo(3);
    bucket.offline = false;
    expect((await advance(1100)).length).toBe(4);
  });

  it("propagates unexpected errors instead of hiding them", async () => {
    const { runner, clock, session } = await setup({ autos: 5 });
    session.crawler.run = async () => {
      throw new TypeError("bug");
    };
    clock.now += 1000;
    await expect(runner.turn()).rejects.toThrow("bug");
    // The runner is usable again afterwards.
    expect(runner.busy).toBe(false);
  });

  it("starts and stops its timer loop", async () => {
    const scheduled = [];
    const timers = {
      setTimeout: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      clearTimeout: (id) => {
        scheduled[id - 1].cleared = true;
      },
    };
    const { runner, clock, session } = await setup({ autos: 5 });
    runner.timers = timers;
    runner.start();
    runner.start();
    expect(scheduled.length).toBe(1);

    clock.now += 1000;
    await scheduled[0].callback();
    expect(session.visitedCount).toBe(2);
    expect(scheduled.length).toBe(2);

    runner.stop();
    expect(scheduled[1].cleared).toBe(true);
    await scheduled[1].callback();
    expect(scheduled.length).toBe(2);
  });
});
