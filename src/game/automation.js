// Paces automatic article opening.
//
// Each auto-opener opens one article every five seconds. Rather than firing
// a timer per article, the runner converts elapsed time into "credit" and
// spends it in batches. This keeps the rate correct when timers are throttled
// (a hidden tab may get one timer a minute, and an idle game is usually left
// in one), lets very high rates work, and keeps the page responsive: a batch
// is bounded in size and time, and the runner hands control back to the
// browser between batches.

import { GraphError } from "../wikiGraph/client.js";

export const SECONDS_PER_AUTO_ARTICLE = 5;
// Time credited at most for one gap between turns. Browsers throttle hidden
// tabs to about one timer a minute; a longer gap means the device slept.
export const MAX_ELAPSED_MS = 5 * 60 * 1000;
// Unspent credit is capped at this much time at the current rate.
export const MAX_BACKLOG_SECONDS = 5 * 60;
export const TURN_INTERVAL_MS = 100;
// One batch: at most this many articles and this much uninterrupted work.
export const MAX_OPENS_PER_BATCH = 5000;
export const TIME_SLICE_MS = 8;
// A turn works through its credit batch by batch for at most this long.
// Whatever is left is carried to the next turn.
export const MAX_TURN_MS = 5000;
const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

export function articlesPerSecond(autos) {
  return autos > 0 ? autos / SECONDS_PER_AUTO_ARTICLE : 0;
}

// Returns the credit after `elapsedMs` at the given number of auto-openers.
export function accrueCredit(credit, elapsedMs, autos) {
  const rate = articlesPerSecond(autos);
  if (rate === 0) {
    return 0;
  }
  const elapsed = Math.min(Math.max(elapsedMs, 0), MAX_ELAPSED_MS);
  const cap = Math.max(1, rate * MAX_BACKLOG_SECONDS);
  return Math.min(credit + (elapsed / 1000) * rate, cap);
}

// Lets the browser handle input and rendering before work continues. A
// message channel is used because, unlike timers, it is not throttled in
// hidden tabs.
function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export class AutomationRunner {
  // `automation` is the save's automation state; its `credit` field is kept
  // up to date so a fraction of an article carries across reloads.
  //
  // onOpened(ordinals)   articles were opened; called at most about once per
  //                      TURN_INTERVAL_MS, also during a long turn
  // onStatus(status)     "running" | "idle" (nothing left to open) |
  //                      "offline" (the graph cannot be reached; retrying)
  constructor({
    crawler,
    automation,
    getAutos,
    onOpened,
    onStatus = () => {},
    now = () => performance.now(),
    timers = globalThis,
    pause = yieldToBrowser,
  }) {
    this.crawler = crawler;
    this.automation = automation;
    this.getAutos = getAutos;
    this.onOpened = onOpened;
    this.onStatus = onStatus;
    this.now = now;
    this.timers = timers;
    this.pause = pause;
    this.status = "running";
    this.lastTurnAt = null;
    this.retryAt = 0;
    this.retryDelay = MIN_RETRY_MS;
    this.timer = null;
    this.running = false;
    this.stopped = false;
    this.busy = false;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopped = false;
    this.lastTurnAt = this.now();
    this.schedule();
  }

  // Also ends a turn that is in progress, after its current batch.
  stop() {
    this.running = false;
    this.stopped = true;
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  schedule() {
    if (!this.running) {
      return;
    }
    this.timer = this.timers.setTimeout(async () => {
      this.timer = null;
      try {
        await this.turn();
      } catch (error) {
        console.error("Automation turn failed:", error);
      }
      this.schedule();
    }, TURN_INTERVAL_MS);
  }

  setStatus(status) {
    if (status !== this.status) {
      this.status = status;
      this.onStatus(status);
    }
  }

  // One turn: accrue credit for the time since the last turn, then spend it
  // batch by batch. Returns the articles opened.
  async turn() {
    if (this.busy) {
      return [];
    }
    this.busy = true;
    const opened = [];
    let reported = 0;
    const report = () => {
      if (opened.length > reported) {
        const fresh = opened.slice(reported);
        reported = opened.length;
        this.onOpened(fresh);
      }
    };

    try {
      const startedAt = this.now();
      const elapsed = this.lastTurnAt === null ? 0 : startedAt - this.lastTurnAt;
      this.lastTurnAt = startedAt;

      const { automation } = this;
      automation.credit = accrueCredit(automation.credit, elapsed, this.getAutos());
      if (startedAt < this.retryAt) {
        return opened;
      }

      let reportedAt = startedAt;
      while (automation.credit >= 1 && !this.stopped) {
        const more = await this.batch();
        for (const ordinal of more.opened) {
          opened.push(ordinal);
        }
        const now = this.now();
        if (more.done || automation.credit < 1 || now - startedAt >= MAX_TURN_MS) {
          break;
        }
        if (now - reportedAt >= TURN_INTERVAL_MS) {
          report();
          reportedAt = now;
        }
        await this.pause();
      }
      return opened;
    } finally {
      this.busy = false;
      report();
    }
  }

  // Spends credit on one batch. `done` means the turn should end: nothing is
  // left to open, or the graph could not be reached.
  async batch() {
    const { automation } = this;
    const budget = Math.min(Math.floor(automation.credit), MAX_OPENS_PER_BATCH);
    let opened;
    let done = false;
    try {
      const result = await this.crawler.run(budget, { timeSliceMs: TIME_SLICE_MS });
      opened = result.opened;
      this.retryDelay = MIN_RETRY_MS;
      if (result.exhausted) {
        // Nothing reachable is left; do not bank time for later.
        automation.credit = opened.length;
        this.setStatus("idle");
        done = true;
      } else {
        this.setStatus("running");
      }
    } catch (error) {
      if (!(error instanceof GraphError)) {
        throw error;
      }
      opened = error.opened ?? [];
      this.retryAt = this.now() + this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
      this.setStatus("offline");
      done = true;
    }
    automation.credit = Math.max(0, automation.credit - opened.length);
    return { opened, done };
  }
}
