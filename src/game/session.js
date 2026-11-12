// One running game: a save, the snapshot it is pinned to, and the crawler.
//
// Nothing here depends on React or the DOM, so the rules that matter most
// (which snapshot a save uses, what counts as opening an article, what gets
// written) can be tested directly.

import { GraphClient, GraphError, fetchManifest, loadLatest, openSnapshot } from "../wikiGraph/client.js";
import {
  HISTORY_LIMIT,
  createSave,
  decodeSave,
  encodeSave,
  exportSave,
  importSave,
} from "../save/saveFormat.js";
import { Crawler } from "./crawler.js";

export class Session {
  constructor({ baseUrl, graph, state, store, isNew, graphOptions }) {
    this.baseUrl = baseUrl;
    this.graph = graph;
    this.state = state;
    this.store = store;
    this.isNew = isNew;
    this.graphOptions = graphOptions;
    this.crawler = new Crawler({
      graph,
      visited: state.visited,
      expanded: state.expanded,
      automation: state.automation,
    });
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
    return this.state.visited.count;
  }

  get startArticle() {
    return this.graph.startArticle;
  }

  hasVisited(ordinal) {
    return this.state.visited.has(ordinal);
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
  async openLink(rawTitle, fromOrdinal) {
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
    const isNew = this.state.visited.add(ordinal);
    if (isNew) {
      this.crawler.prioritize(ordinal);
    }
    return {
      status: isNew ? "opened" : "seen",
      ordinal,
      title: await this.canonicalTitle(match),
    };
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
  addHistory(items, keepSeq) {
    const { game } = this;
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
    if (history.length > HISTORY_LIMIT) {
      const excess = history.length - HISTORY_LIMIT;
      let dropped = 0;
      history = history.filter((entry) => {
        if (dropped < excess && entry.seq !== keepSeq) {
          dropped += 1;
          return false;
        }
        return true;
      });
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
