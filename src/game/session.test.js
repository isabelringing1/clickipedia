import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { PlayerStore } from "../save/playerStore.js";
import { HISTORY_LIMIT, SaveError } from "../save/saveFormat.js";
import { BASE_URL, FakeBucket, expected, fastOptions } from "../testing/fixtureGraph.js";
import { GraphError } from "../wikiGraph/client.js";
import { startSession } from "./session.js";

const ROOT = `snapshots/${expected.snapshotId}/`;

let bucket;
let indexedDB;

beforeEach(() => {
  bucket = new FakeBucket();
  indexedDB = new IDBFactory();
});

// Starts the game the way a page load does: a new store connection and a
// new graph client, sharing only the database and the bucket.
async function load(extra) {
  const store = await PlayerStore.open({ indexedDB });
  return startSession({ baseUrl: BASE_URL, store, graphOptions: fastOptions(bucket, extra) });
}

async function reload(session, extra) {
  await session.save();
  session.store.close();
  return load(extra);
}

describe("a fresh save", () => {
  it("pins the snapshot latest.json names and opens only the start article", async () => {
    const session = await load();
    expect(session.isNew).toBe(true);
    expect(session.snapshotId).toBe(expected.snapshotId);
    expect(session.articleCount).toBe(expected.counts.articles);
    expect(session.visitedCount).toBe(1);
    expect(session.hasVisited(expected.startArticle.ordinal)).toBe(true);
    expect(session.startArticle).toEqual(expected.startArticle);
    expect(session.game).toMatchObject({ knowledge: 1, autos: 0, history: [] });
  });

  it("is written before the game starts", async () => {
    const session = await load();
    const record = await session.store.load();
    expect(record.snapshotId).toBe(expected.snapshotId);
    expect(record.manifestSha256).toBe(bucket.json("latest.json").manifestSha256);
    expect(record.visitedCount).toBe(1);
  });

  it("cannot start without the graph, and leaves no save behind", async () => {
    bucket.offline = true;
    const error = await load({ retries: 1 }).catch((caught) => caught);
    expect(error).toBeInstanceOf(GraphError);
    expect(error.code).toBe("network");
    const store = await PlayerStore.open({ indexedDB });
    expect(await store.load()).toBeNull();
  });
});

describe("snapshot pinning", () => {
  it("keeps an existing save on its snapshot after latest.json is promoted", async () => {
    const first = await load();
    await first.openLink("Cookie Clicker", 0);
    const pinnedHash = first.state.manifestSha256;

    const promoted = bucket.promoteCopy("20260201");
    expect(promoted.manifestSha256).not.toBe(pinnedHash);
    bucket.requests.length = 0;

    const second = await reload(first);
    expect(second.isNew).toBe(false);
    expect(second.snapshotId).toBe(expected.snapshotId);
    expect(second.state.manifestSha256).toBe(pinnedHash);
    expect(second.visitedCount).toBe(2);
    // Reloading reads neither the pointer nor the manifest.
    expect(bucket.requests).toEqual([]);

    await second.openLink("Café", 0);
    expect(bucket.requests.every((request) => request.path.startsWith(ROOT))).toBe(true);
  });

  it("starts new saves on the promoted snapshot", async () => {
    const old = await load();
    old.store.close();
    bucket.promoteCopy("20260201");

    indexedDB = new IDBFactory();
    const fresh = await load();
    expect(fresh.isNew).toBe(true);
    expect(fresh.snapshotId).toBe("20260201");
    await fresh.openLink("Cookie Clicker", 0);
    expect(
      bucket.requests
        .filter((request) => request.path !== "latest.json")
        .slice(-2)
        .every((request) => request.path.startsWith("snapshots/20260201/")),
    ).toBe(true);
  });

  it("moves to the new snapshot only after a reset", async () => {
    const first = await load();
    await first.openLink("Cookie Clicker", 0);
    bucket.promoteCopy("20260201");
    expect((await reload(first)).snapshotId).toBe(expected.snapshotId);

    const store = await PlayerStore.open({ indexedDB });
    await store.clear();
    store.close();
    const second = await load();
    expect(second.isNew).toBe(true);
    expect(second.snapshotId).toBe("20260201");
    expect(second.visitedCount).toBe(1);
  });
});

describe("reloading", () => {
  it("restores progress exactly", async () => {
    const first = await load();
    await first.openLink("cookie Clicker", 0);
    await first.openLink("cafe", 0);
    first.game.knowledge = 42;
    first.game.autos = 2;
    first.game.quests = { "quest-1": { complete: true, quest: { id: "quest-1" } } };
    first.game.purchasedItems = { "auto-1": true };
    first.addHistory([{ kind: "article", ordinal: 1, title: "Cookie_Clicker" }, { kind: "quest" }]);
    await first.crawler.run(2);

    const second = await reload(first);
    expect(second.isNew).toBe(false);
    expect(second.visitedCount).toBe(first.visitedCount);
    for (let ordinal = 0; ordinal < second.articleCount; ordinal += 1) {
      expect(second.hasVisited(ordinal)).toBe(first.hasVisited(ordinal));
    }
    expect(second.game).toEqual(first.game);
    expect(second.state.automation).toEqual(first.state.automation);
    expect(second.state.expanded.count).toBe(first.state.expanded.count);
    expect(second.state.createdAt).toBe(first.state.createdAt);
  });

  it("works offline: the save loads and reports the graph as unreachable", async () => {
    const first = await load();
    await first.openLink("Cookie Clicker", 0);
    bucket.offline = true;

    const second = await reload(first, { retries: 0 });
    expect(second.visitedCount).toBe(2);
    expect(second.articleCount).toBe(expected.counts.articles);
    const error = await second.openLink("Café", 0).catch((caught) => caught);
    expect(error).toBeInstanceOf(GraphError);
    expect(error.transient).toBe(true);
    expect(second.visitedCount).toBe(2);

    bucket.offline = false;
    expect((await second.openLink("Café", 0)).status).toBe("opened");
  });

  it("surfaces an unreadable save instead of silently starting over", async () => {
    const first = await load();
    await first.openLink("Cookie Clicker", 0);
    const record = first.record();
    record.visited = record.visited.slice(0, 1);
    await first.store.write(record);
    first.store.close();

    const error = await load().catch((caught) => caught);
    expect(error).toBeInstanceOf(SaveError);
    expect(error.code).toBe("invalid");
    // The damaged save is still there for the player to deal with.
    const store = await PlayerStore.open({ indexedDB });
    expect((await store.load()).snapshotId).toBe(expected.snapshotId);
  });
});

describe("opening links", () => {
  it("opens an article once, by any spelling of its title", async () => {
    const session = await load();
    expect(await session.openLink("cookie Clicker", 0)).toEqual({
      status: "opened",
      ordinal: 1,
      title: "Cookie_Clicker",
    });
    expect(await session.openLink("Cookie_Clicker#Gameplay", 0)).toEqual({
      status: "seen",
      ordinal: 1,
      title: "Cookie_Clicker",
    });
    expect(session.visitedCount).toBe(2);
  });

  it("follows redirects to the article and shows its real title", async () => {
    const session = await load();
    expect(await session.openLink("Cafe", 0)).toEqual({ status: "opened", ordinal: 4, title: "Café" });
    expect(await session.openLink("Section redirect", 0)).toEqual({
      status: "opened",
      ordinal: 1,
      title: "Cookie_Clicker",
    });
    expect(await session.openLink("Cookie Clicker", 0)).toMatchObject({ status: "seen" });
  });

  it("recognises links back to the same article, including via a redirect", async () => {
    const session = await load();
    expect(await session.openLink("Incremental game#History", 0)).toMatchObject({
      status: "self",
      ordinal: 0,
    });
    expect(await session.openLink("Idle game", 0)).toMatchObject({ status: "self", ordinal: 0 });
    expect(await session.openLink("Idle game", 1)).toMatchObject({ status: "seen", ordinal: 0 });
    expect(session.visitedCount).toBe(1);
  });

  it("does not open anything that is not an article in the snapshot", async () => {
    const session = await load();
    for (const title of [...expected.notFound, "", "Category:Games", "File:X.png"]) {
      expect(await session.openLink(title, 0), title).toEqual({ status: "missing" });
    }
    expect(session.visitedCount).toBe(1);
  });

  it("counts two simultaneous clicks on one link once", async () => {
    const session = await load();
    const results = await Promise.all([
      session.openLink("Cafe", 0),
      session.openLink("Café", 0),
      session.openLink("cafe", 0),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["opened", "seen", "seen"]);
    expect(session.visitedCount).toBe(2);
  });

  it("still opens a redirect when its real title cannot be loaded", async () => {
    const session = await load({ retries: 0 });
    await session.graph.resolveTitle("Cafe");
    bucket.offline = true;
    expect(await session.openLink("Cafe", 0)).toEqual({ status: "opened", ordinal: 4, title: "Cafe" });
  });

  it("sends the crawler to hand-opened articles first", async () => {
    const session = await load();
    await session.openLink("Twin A", 0);
    expect(session.state.automation.priority).toEqual([8]);
    const { opened } = await session.crawler.run(1);
    expect(opened).toEqual([9]);
  });

  it("never reaches articles that no chain of links from the start leads to", async () => {
    // Such articles count toward the total but cannot be obtained by play.
    const session = await load();
    await session.crawler.run(1000);
    expect(session.visitedCount).toBe(expected.connectivity.reachableFromStart);
    for (const ordinal of expected.connectivity.unreachableFromStart) {
      expect(session.hasVisited(ordinal)).toBe(false);
    }
    expect(session.articleCount).toBe(expected.counts.articles);
  });
});

describe("history", () => {
  it("assigns increasing sequence numbers and spawn positions", async () => {
    const session = await load();
    const added = session.addHistory([
      { kind: "article", ordinal: 1, title: "Cookie_Clicker" },
      { kind: "quest" },
      { kind: "article", ordinal: 4, title: "Café" },
    ]);
    expect(added).toEqual([
      { seq: 1, kind: "article", ordinal: 1, title: "Cookie_Clicker", spawn: 1 },
      { seq: 2, kind: "quest" },
      { seq: 3, kind: "article", ordinal: 4, title: "Café", spawn: 2 },
    ]);
    expect(session.game.history).toEqual(added);
    expect(session.game.nextSeq).toBe(4);
  });

  it("stays bounded, dropping the oldest entries but not the one being read", async () => {
    const session = await load();
    const [reading] = session.addHistory([{ kind: "article", ordinal: 1, title: "Cookie_Clicker" }]);
    for (let i = 0; i < HISTORY_LIMIT * 3; i += 1) {
      session.addHistory([{ kind: "article", ordinal: 4, title: "Café" }], reading.seq);
    }
    const { history } = session.game;
    expect(history.length).toBe(HISTORY_LIMIT);
    expect(history[0]).toEqual(reading);
    expect(history[1].seq).toBe(HISTORY_LIMIT * 3 + 1 - (HISTORY_LIMIT - 2));
    expect(history[history.length - 1].seq).toBe(HISTORY_LIMIT * 3 + 1);

    session.addHistory([{ kind: "quest" }]);
    expect(session.game.history.length).toBe(HISTORY_LIMIT);
    expect(session.game.history[0].seq).not.toBe(reading.seq);
  });
});

describe("export and import", () => {
  it("moves a game to another browser", async () => {
    const first = await load();
    await first.openLink("Cookie Clicker", 0);
    first.game.knowledge = 77;
    const text = first.exportText();

    indexedDB = new IDBFactory();
    const other = await load();
    expect(other.visitedCount).toBe(1);
    const record = await other.prepareImport(text);
    await other.store.write(record);
    other.store.close();

    const restored = await load();
    expect(restored.isNew).toBe(false);
    expect(restored.visitedCount).toBe(2);
    expect(restored.hasVisited(1)).toBe(true);
    expect(restored.game.knowledge).toBe(77);
  });

  it("keeps an imported save on its own snapshot", async () => {
    const first = await load();
    const text = first.exportText();
    bucket.promoteCopy("20260201");

    indexedDB = new IDBFactory();
    const other = await load();
    expect(other.snapshotId).toBe("20260201");
    await other.store.write(await other.prepareImport(text));
    other.store.close();
    expect((await load()).snapshotId).toBe(expected.snapshotId);
  });

  it("refuses a save whose snapshot is not published here", async () => {
    const first = await load();
    const text = first.exportText();
    for (const path of [...bucket.files.keys()]) {
      if (path.startsWith(ROOT)) {
        bucket.files.delete(path);
      }
    }
    const error = await first.prepareImport(text).catch((caught) => caught);
    expect(error).toBeInstanceOf(GraphError);
    expect(error.status).toBe(404);
  });

  it("refuses a save whose manifest differs from the published one", async () => {
    const first = await load();
    const document = JSON.parse(first.exportText());
    document.manifestSha256 = "0".repeat(64);
    const error = await first.prepareImport(JSON.stringify(document)).catch((caught) => caught);
    expect(error).toBeInstanceOf(GraphError);
    expect(error.code).toBe("corrupt");
  });

  it("refuses files that are not saves", async () => {
    const session = await load();
    await expect(session.prepareImport("{}")).rejects.toBeInstanceOf(SaveError);
  });
});
