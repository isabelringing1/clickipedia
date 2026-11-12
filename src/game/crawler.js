// Opens articles automatically by following links in the stored graph.
//
// The frontier is never stored as a list. An article is "pending" when it has
// been opened (`visited`) but its links have not all been followed
// (`expanded`), so the frontier is the difference of two bitsets and stays
// the same size however far the crawl gets. The only extra state is where
// the bot is: the article whose links it is following and how many of them
// it has handled.
//
// Sources are chosen to keep network use low. Links live in shards covering
// a range of ordinals, so after an article the bot prefers other pending
// articles in the shard it already has, then sweeps upward to the next
// pending article. Articles the player opened by hand jump the queue so the
// crawl visibly follows them.

import { nextInDifference } from "../save/bitset.js";
import { NO_SOURCE, PRIORITY_LIMIT } from "../save/saveFormat.js";

export class Crawler {
  constructor({ graph, visited, expanded, automation, now = () => performance.now() }) {
    this.graph = graph;
    this.visited = visited;
    this.expanded = expanded;
    this.automation = automation;
    this.now = now;
    this.currentShard = -1;
  }

  // Asks the crawler to follow this article's links soon.
  prioritize(ordinal) {
    const { priority } = this.automation;
    priority.push(ordinal);
    if (priority.length > PRIORITY_LIMIT) {
      // Dropped articles are still pending and are found by the sweep.
      priority.splice(0, priority.length - PRIORITY_LIMIT);
    }
  }

  isPending(ordinal) {
    return this.visited.has(ordinal) && !this.expanded.has(ordinal);
  }

  // Picks the next article whose links to follow, or -1 when every opened
  // article has been fully followed.
  pickSource() {
    const { automation, visited, expanded, graph } = this;

    while (automation.priority.length > 0) {
      const ordinal = automation.priority.shift();
      if (this.isPending(ordinal)) {
        return ordinal;
      }
    }

    if (this.currentShard >= 0 && graph.isAdjacencyShardCached(this.currentShard)) {
      const [first, end] = graph.adjacencyShardRange(this.currentShard);
      const local = nextInDifference(visited, expanded, first, end);
      if (local !== -1) {
        return local;
      }
    }

    let next = nextInDifference(visited, expanded, automation.scanCursor, visited.size);
    if (next === -1) {
      next = nextInDifference(visited, expanded, 0, automation.scanCursor);
    }
    if (next !== -1) {
      automation.scanCursor = next + 1 < visited.size ? next + 1 : 0;
    }
    return next;
  }

  // Opens up to `budget` new articles. Stops early when the time slice is
  // used up (so the page stays responsive) or when nothing is left to open.
  //
  // If the graph cannot be read this rejects with the client's error. State
  // stays consistent: articles opened before the failure are returned on the
  // error as `opened`, and the bot resumes at the same link next time.
  async run(budget, { timeSliceMs = 8 } = {}) {
    const bot = this.automation.bots[0];
    const opened = [];
    const started = this.now();
    let exhausted = false;

    while (opened.length < budget) {
      if (bot.source === NO_SOURCE) {
        const next = this.pickSource();
        if (next === -1) {
          exhausted = true;
          break;
        }
        bot.source = next;
        bot.cursor = 0;
      }

      let neighbors;
      try {
        neighbors = await this.graph.getNeighbors(bot.source);
      } catch (error) {
        error.opened = opened;
        throw error;
      }
      this.currentShard = this.graph.adjacencyShardOf(bot.source);

      let cursor = Math.min(bot.cursor, neighbors.length);
      while (cursor < neighbors.length && opened.length < budget) {
        const target = neighbors[cursor];
        cursor += 1;
        if (this.visited.add(target)) {
          opened.push(target);
        }
      }

      if (cursor >= neighbors.length) {
        this.expanded.add(bot.source);
        bot.source = NO_SOURCE;
        bot.cursor = 0;
      } else {
        bot.cursor = cursor;
      }

      if (this.now() - started >= timeSliceMs) {
        break;
      }
    }

    return { opened, exhausted };
  }
}
