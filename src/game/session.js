// One running game: a save, the snapshot it is pinned to, and the crawler.
//
// Nothing here depends on React or the DOM, so the rules that matter most
// (which snapshot a save uses, what counts as opening an article, what gets
// written) can be tested directly.

import { GraphClient, GraphError, fetchManifest, loadLatest, openSnapshot } from "../wikiGraph/client.js";
import {
  HISTORY_LIMIT,
  MANUAL_HISTORY_LIMIT,
  createRoomState,
  createSave,
  decodeSave,
  encodeSave,
  exportSave,
  importSave,
} from "../save/saveFormat.js";
import { Crawler } from "./crawler.js";
import topicCatalog from "../../topic-catalog.json";

const TOPIC_ROOMS = topicCatalog.topics.map((topic, topicIndex) => ({
  ...topic,
  topicIndex,
}));

export class Session {
  constructor({ baseUrl, graph, state, store, isNew, graphOptions }) {
    this.baseUrl = baseUrl;
    this.graph = graph;
    this.state = state;
    this.store = store;
    this.isNew = isNew;
    this.graphOptions = graphOptions;
    this.crawlers = new Map();
    this.automationNovelty = new Map();
    for (const room of Object.values(state.rooms)) {
      this.attachCrawler(room);
    }
    this.crawler = this.crawlers.get("general");
    const general = state.rooms.general;
    state.visited = general.visited;
    state.expanded = general.expanded;
    state.automation = general.automation;
    for (const field of ["autos", "purchasedItems", "history", "nextSeq", "spawnCount"]) {
      Object.defineProperty(state.game, field, {
        enumerable: true,
        configurable: true,
        get: () => general[field],
        set: (value) => {
          general[field] = value;
        },
      });
    }
  }

  get game() {
    return this.state.game;
  }

  get snapshotId() {
    return this.state.snapshotId;
  }

  // Articles in the pinned snapshot, including ones no link leads to.
  get articleCount() {
    return this.graph.articleCount;
  }

  // Articles opened so far, including the start article.
  get visitedCount() {
    return this.state.globalVisited.count;
  }

  get startArticle() {
    return this.graph.startArticle;
  }

  hasVisited(ordinal) {
    return this.state.globalVisited.has(ordinal);
  }

  get rooms() {
    return this.state.rooms;
  }

  room(id) {
    const room = this.rooms[id];
    if (!room) {
      throw new RangeError(`room "${id}" is not unlocked`);
    }
    return room;
  }

  attachCrawler(room) {
    const crawler = new Crawler({
      graph: this.graph,
      visited: room.visited,
      expanded: room.expanded,
      automation: room.automation,
      acceptTarget:
        room.topicIndex === null
          ? () => true
          : (ordinal) => this.graph.hasTopic(ordinal, room.topicIndex),
      onVisit: (ordinal) => {
        this.automationNovelty.set(
          `${room.id}:${ordinal}`,
          this.state.globalVisited.add(ordinal),
        );
      },
      exhausted: room.blocked,
    });
    this.crawlers.set(room.id, crawler);
    return crawler;
  }

  unlockRoom({ id, label, topicIndex }, root) {
    if (this.rooms[id]) {
      return this.rooms[id];
    }
    const room = createRoomState({
      id,
      label,
      topicIndex,
      root,
      articleCount: this.articleCount,
    });
    this.rooms[id] = room;
    this.attachCrawler(room);
    return room;
  }

  // The canonical title of an article, for display.
  async titleOf(ordinal) {
    return (await this.graph.getArticle(ordinal)).title;
  }

  // Handles the player following a link with the given target title from the
  // article `fromOrdinal`. Resolves to one of:
  //   { status: "missing" }                   not an article in this snapshot
  //   { status: "self", ordinal, title }      leads back to the same article
  //   { status: "seen", ordinal, title }      already opened
  //   { status: "opened", ordinal, title }    newly opened
  // Rejects with a GraphError when the graph cannot be read.
  async openLink(roomId, rawTitle, fromOrdinal) {
    const legacyCall = fromOrdinal === undefined;
    if (legacyCall) {
      fromOrdinal = rawTitle;
      rawTitle = roomId;
      roomId = "general";
    }
    const room = this.room(roomId);
    const match = await this.graph.resolveTitle(rawTitle);
    if (match === null) {
      return { status: "missing" };
    }
    const { ordinal } = match;
    if (ordinal === fromOrdinal) {
      return { status: "self", ordinal, title: match.title };
    }
    // Mark the article before any further waiting, so a second click on the
    // same link while a title is loading counts as already opened.
    const roomNew = room.visited.add(ordinal);
    const globalNew = roomNew && this.state.globalVisited.add(ordinal);
    if (roomNew) {
      this.crawlers.get(roomId).prioritize(ordinal);
      room.blocked = false;
    }
    const title = await this.canonicalTitle(match);
    let topicMask = 0n;
    try {
      topicMask = await this.graph.getTopicMask(ordinal);
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
    }
    const unlocked = [];
    // An article can introduce only one room, and only the first time that
    // article is opened anywhere. Opening it again in another room cannot be
    // used to unlock another one of its topics.
    if (globalNew) {
      for (const definition of TOPIC_ROOMS) {
        if (
          (topicMask & (1n << BigInt(definition.topicIndex))) !== 0n &&
          !this.rooms[definition.id]
        ) {
          const unlockedRoom = this.unlockRoom(definition, { ordinal, title });
          unlockedRoom.newlyUnlocked = true;
          unlocked.push(definition.id);
          break;
        }
      }
    }
    const result = {
      status: roomNew ? "opened" : "seen",
      ordinal,
      title,
      globalNew,
      topicMask,
      unlocked,
    };
    if (legacyCall) {
      delete result.globalNew;
      delete result.topicMask;
      delete result.unlocked;
    }
    return result;
  }

  recordAutomatedOpen(roomId, ordinal) {
    const room = this.room(roomId);
    room.topicOpenedCount += 1;
    const noveltyKey = `${roomId}:${ordinal}`;
    const recorded = this.automationNovelty.get(noveltyKey);
    this.automationNovelty.delete(noveltyKey);
    const globalNew =
      recorded === undefined ? this.state.globalVisited.add(ordinal) : recorded;
    if (globalNew) {
      this.game.knowledge += 1;
      room.knowledge += 1;
    }
    return globalNew;
  }

  // A link may name a redirect; show the article's own title when it can be
  // looked up, and fall back to the link's title when it cannot.
  async canonicalTitle(match) {
    if (!match.isRedirect) {
      return match.title;
    }
    try {
      return await this.titleOf(match.ordinal);
    } catch (error) {
      if (error instanceof GraphError) {
        return match.title;
      }
      throw error;
    }
  }

  // Appends to the bounded display history and returns the new entries.
  // `keepSeq` protects one entry (the article being read) from eviction.
  addHistory(roomId, items, keepSeq) {
    if (Array.isArray(roomId)) {
      keepSeq = items;
      items = roomId;
      roomId = "general";
    }
    const game = this.room(roomId);
    const added = items.map((item) => {
      const entry = { seq: game.nextSeq, ...item };
      game.nextSeq += 1;
      if (entry.kind === "article") {
        game.spawnCount += 1;
        entry.spawn = game.spawnCount;
      }
      return entry;
    });
    let history = [...game.history, ...added];
    const protectedEntries = new Set(
      history
        .filter((entry) => entry.source !== "auto")
        .slice(-MANUAL_HISTORY_LIMIT)
        .map((entry) => entry.seq),
    );
    if (keepSeq !== undefined) {
      protectedEntries.add(keepSeq);
    }
    for (const entry of history) {
      if (
        entry.kind === "quest" &&
        protectedEntries.has(entry.seq) &&
        Number.isInteger(entry.articleSeq)
      ) {
        protectedEntries.add(entry.articleSeq);
      }
    }
    let dropped = 0;
    history = history.filter((entry) => {
      if (entry.source !== "auto" && !protectedEntries.has(entry.seq)) {
        dropped += 1;
        return false;
      }
      return true;
    });
    if (history.length > HISTORY_LIMIT) {
      const excess = history.length - HISTORY_LIMIT;
      let capacityDropped = 0;
      history = history.filter((entry) => {
        if (
          capacityDropped < excess &&
          !protectedEntries.has(entry.seq)
        ) {
          capacityDropped += 1;
          return false;
        }
        return true;
      });
      dropped += capacityDropped;
    }
    if (dropped > 0) {
      game.historyDroppedCount += dropped;
    }
    game.history = history;
    return added;
  }

  record(now) {
    return encodeSave(this.state, now);
  }

  async save(now) {
    await this.store.write(this.record(now));
  }

  exportText(now) {
    return exportSave(this.record(now), now);
  }

  // Checks an exported save and returns the record to store. The snapshot it
  // is pinned to must still be published, because the game cannot run
  // without its shards.
  async prepareImport(text) {
    const record = importSave(text);
    await fetchManifest(this.baseUrl, record.snapshotId, record.manifestSha256, this.graphOptions);
    return record;
  }
}

// Loads the existing save or starts a new game.
//
// An existing save is opened on the snapshot it names, using the manifest
// stored inside it: no request is made, and publishing a newer snapshot does
// not move it. Only a new game reads latest.json, and its pin is written
// before the game starts.
export async function startSession({ baseUrl, store, graphOptions, now = Date.now() }) {
  const record = await store.load();
  if (record !== null) {
    const state = decodeSave(record);
    const graph = new GraphClient({
      baseUrl,
      manifest: state.manifest,
      manifestSha256: state.manifestSha256,
      options: graphOptions,
    });
    return new Session({ baseUrl, graph, state, store, isNew: false, graphOptions });
  }

  const latest = await loadLatest(baseUrl, graphOptions);
  const graph = await openSnapshot(baseUrl, latest, graphOptions);
  const state = createSave({
    manifest: graph.manifest,
    manifestSha256: latest.manifestSha256,
    now,
  });
  const session = new Session({ baseUrl, graph, state, store, isNew: true, graphOptions });
  await session.save(now);
  return session;
}
