// The shape of a player's save and its conversions.
//
// A save exists in three forms:
//   state    the live object the game mutates (bitsets as Bitset instances)
//   record   what IndexedDB stores (bitsets as Uint8Array, everything else
//            structured-cloneable)
//   export   a JSON document for backup and transfer (bitsets as base64)
//
// SAVE_VERSION describes the record. It is independent of the link graph's
// schema version: the graph format can change without touching saves, and a
// save keeps naming the exact snapshot it was started on.

import { validateManifest } from "../wikiGraph/client.js";
import { Bitset, SparseBitset } from "./bitset.js";

export const SAVE_VERSION = 2;
export const EXPORT_FORMAT = "clickipedia-save";

export const HISTORY_LIMIT = 100;
export const MANUAL_HISTORY_LIMIT = 50;
export const PRIORITY_LIMIT = 256;
export const NO_SOURCE = -1;

// `code` is one of:
//   invalid      the data is not a usable save
//   unsupported  the save was written by a newer version of the game
//   unavailable  this browser cannot store saves
export class SaveError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "SaveError";
    this.code = code;
  }
}

function invalid(message) {
  return new SaveError("invalid", `This save cannot be used: ${message}.`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOrdinal(value, articleCount) {
  return Number.isInteger(value) && value >= 0 && value < articleCount;
}

function idleBot() {
  return { source: NO_SOURCE, cursor: 0 };
}

export function createRoomState({
  id,
  label,
  root,
  articleCount,
  topicIndex = null,
}) {
  const visited = new SparseBitset(articleCount);
  visited.add(root.ordinal);
  return {
    id,
    label,
    topicIndex,
    root: { ordinal: root.ordinal, title: root.title },
    visited,
    expanded: new SparseBitset(articleCount),
    automation: {
      bots: [idleBot()],
      scanCursor: 0,
      priority: [],
      credit: 0,
    },
    knowledge: 0,
    topicOpenedCount: 1,
    autos: 0,
    purchasedItems: {},
    history: [],
    historyDroppedCount: 0,
    nextSeq: 1,
    spawnCount: 0,
    blocked: false,
    newlyUnlocked: false,
  };
}

function attachGeneralAliases(state) {
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
  return state;
}

// A new game on the given snapshot: only the start article is open.
export function createSave({ manifest, manifestSha256, now = Date.now() }) {
  validateManifest(manifest);
  const articleCount = manifest.counts.articles;
  const globalVisited = new Bitset(articleCount);
  globalVisited.add(manifest.startArticle.ordinal);
  const general = createRoomState({
    id: "general",
    label: "General",
    root: manifest.startArticle,
    articleCount,
  });
  return attachGeneralAliases({
    saveVersion: SAVE_VERSION,
    createdAt: now,
    savedAt: now,
    snapshotId: manifest.snapshotId,
    manifestSha256,
    manifest,
    globalVisited,
    rooms: { general },
    game: {
      knowledge: 1,
      quests: {},
      hasLeftGeneralRoom: false,
      lastRoomId: "general",
      lastView: "articles",
    },
  });
}

export function encodeSave(state, now = Date.now()) {
  const rooms = Object.fromEntries(
    Object.entries(state.rooms).map(([id, room]) => [
      id,
      {
        id: room.id,
        label: room.label,
        topicIndex: room.topicIndex,
        root: { ...room.root },
        visitedCount: room.visited.count,
        visited: room.visited.toChunks(),
        expanded: room.expanded.toChunks(),
        automation: {
          bots: room.automation.bots.map(({ source, cursor }) => ({ source, cursor })),
          scanCursor: room.automation.scanCursor,
          priority: [...room.automation.priority],
          credit: room.automation.credit,
        },
        knowledge: room.knowledge,
        topicOpenedCount: room.topicOpenedCount,
        autos: room.autos,
        purchasedItems: { ...room.purchasedItems },
        history: room.history.map((entry) => ({
          ...entry,
          ...(entry.unlockedTopic
            ? { unlockedTopic: { ...entry.unlockedTopic } }
            : {}),
        })),
        historyDroppedCount: room.historyDroppedCount,
        nextSeq: room.nextSeq,
        spawnCount: room.spawnCount,
        blocked: room.blocked,
        newlyUnlocked: room.newlyUnlocked,
      },
    ]),
  );
  return {
    saveVersion: SAVE_VERSION,
    createdAt: state.createdAt,
    savedAt: now,
    snapshotId: state.snapshotId,
    manifestSha256: state.manifestSha256,
    manifest: state.manifest,
    articleCount: state.globalVisited.size,
    visitedCount: state.globalVisited.count,
    globalVisited: state.globalVisited.toBytes(),
    rooms,
    game: {
      knowledge: state.game.knowledge,
      quests: state.game.quests,
      hasLeftGeneralRoom: state.game.hasLeftGeneralRoom === true,
      lastRoomId:
        typeof state.game.lastRoomId === "string"
          ? state.game.lastRoomId
          : "general",
      lastView: state.game.lastView === "topics" ? "topics" : "articles",
    },
  };
}

function decodeHistory(value, articleCount) {
  if (!Array.isArray(value)) {
    throw invalid("its history is missing");
  }
  const history = [];
  let lastSeq = 0;
  for (const entry of value) {
    if (!isPlainObject(entry) || !Number.isInteger(entry.seq) || entry.seq <= lastSeq) {
      throw invalid("its history is out of order");
    }
    lastSeq = entry.seq;
    if (entry.kind === "quest") {
      history.push({
        seq: entry.seq,
        kind: "quest",
        ...(typeof entry.title === "string" && entry.title !== ""
          ? { title: entry.title }
          : {}),
        ...(Number.isInteger(entry.articleSeq) && entry.articleSeq >= 0
          ? { articleSeq: entry.articleSeq }
          : {}),
      });
    } else if (
      entry.kind === "article" &&
      isOrdinal(entry.ordinal, articleCount) &&
      typeof entry.title === "string" &&
      entry.title !== ""
    ) {
      const unlockedTopic =
        isPlainObject(entry.unlockedTopic) &&
        typeof entry.unlockedTopic.id === "string" &&
        typeof entry.unlockedTopic.label === "string" &&
        entry.unlockedTopic.label !== ""
          ? {
              id: entry.unlockedTopic.id,
              label: entry.unlockedTopic.label,
            }
          : null;
      history.push({
        seq: entry.seq,
        kind: "article",
        ordinal: entry.ordinal,
        title: entry.title,
        spawn: Number.isInteger(entry.spawn) && entry.spawn > 0 ? entry.spawn : 1,
        ...(entry.source === "auto" ? { source: "auto" } : {}),
        ...(unlockedTopic ? { unlockedTopic } : {}),
      });
    } else {
      throw invalid("its history has an unreadable entry");
    }
  }
  const protectedManual = new Set(
    history
      .filter((entry) => entry.source !== "auto")
      .slice(-MANUAL_HISTORY_LIMIT)
      .map((entry) => entry.seq),
  );
  for (const entry of history) {
    if (
      entry.kind === "quest" &&
      protectedManual.has(entry.seq) &&
      Number.isInteger(entry.articleSeq)
    ) {
      protectedManual.add(entry.articleSeq);
    }
  }
  let dropped = 0;
  let bounded = history.filter((entry) => {
    if (entry.source !== "auto" && !protectedManual.has(entry.seq)) {
      dropped += 1;
      return false;
    }
    return true;
  });
  if (bounded.length > HISTORY_LIMIT) {
    const excess = bounded.length - HISTORY_LIMIT;
    let capacityDropped = 0;
    bounded = bounded.filter((entry) => {
      if (
        capacityDropped < excess &&
        !protectedManual.has(entry.seq)
      ) {
        capacityDropped += 1;
        return false;
      }
      return true;
    });
    dropped += capacityDropped;
  }
  return { history: bounded, dropped };
}

function decodeGame(value) {
  if (!isPlainObject(value)) {
    throw invalid("its game progress is missing");
  }
  if (!Number.isFinite(value.knowledge)) {
    throw invalid("its knowledge is not a number");
  }
  if (!isPlainObject(value.quests)) {
    throw invalid("its quests are missing");
  }
  return {
    knowledge: value.knowledge,
    quests: value.quests,
    hasLeftGeneralRoom: value.hasLeftGeneralRoom === true,
    lastRoomId:
      typeof value.lastRoomId === "string" ? value.lastRoomId : "general",
    lastView: value.lastView === "topics" ? "topics" : "articles",
  };
}

// Automation state only says where the crawl resumes, so anything that does
// not fit the bitsets is dropped rather than treated as fatal: the crawler
// can always rebuild its position from `visited` and `expanded`.
function decodeAutomation(value, visited, expanded) {
  const source = isPlainObject(value) ? value : {};
  const size = visited.size;
  const pending = (ordinal) =>
    isOrdinal(ordinal, size) && visited.has(ordinal) && !expanded.has(ordinal);

  const bots = (Array.isArray(source.bots) ? source.bots : []).slice(0, 1).map((bot) =>
    isPlainObject(bot) && pending(bot.source) && Number.isInteger(bot.cursor) && bot.cursor >= 0
      ? { source: bot.source, cursor: bot.cursor }
      : idleBot(),
  );
  if (bots.length === 0) {
    bots.push(idleBot());
  }

  return {
    bots,
    scanCursor: isOrdinal(source.scanCursor, size) ? source.scanCursor : 0,
    priority: (Array.isArray(source.priority) ? source.priority : [])
      .filter(pending)
      .slice(-PRIORITY_LIMIT),
    credit: Number.isFinite(source.credit) && source.credit > 0 ? source.credit : 0,
  };
}

function decodeRoom(value, articleCount) {
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    !isPlainObject(value.root) ||
    !isOrdinal(value.root.ordinal, articleCount) ||
    typeof value.root.title !== "string"
  ) {
    throw invalid("one of its rooms is unreadable");
  }
  let visited;
  let expanded;
  try {
    visited = SparseBitset.fromChunks(articleCount, value.visited);
    expanded = SparseBitset.fromChunks(articleCount, value.expanded);
  } catch (cause) {
    throw new SaveError("invalid", `This save cannot be used: ${cause.message}.`, { cause });
  }
  visited.add(value.root.ordinal);
  expanded.intersectWith(visited);
  const decodedHistory = decodeHistory(value.history, articleCount);
  const { history } = decodedHistory;
  const lastSeq = history.length > 0 ? history[history.length - 1].seq : 0;
  return {
    id: value.id,
    label: value.label,
    topicIndex:
      value.topicIndex === null ||
      (Number.isInteger(value.topicIndex) && value.topicIndex >= 0 && value.topicIndex < 64)
        ? value.topicIndex
        : null,
    root: { ordinal: value.root.ordinal, title: value.root.title },
    visited,
    expanded,
    automation: decodeAutomation(value.automation, visited, expanded),
    knowledge: Number.isFinite(value.knowledge) && value.knowledge >= 0 ? value.knowledge : 0,
    topicOpenedCount:
      Number.isInteger(value.topicOpenedCount) && value.topicOpenedCount >= 1
        ? value.topicOpenedCount
        : 1,
    autos: Number.isInteger(value.autos) && value.autos >= 0 ? value.autos : 0,
    purchasedItems: isPlainObject(value.purchasedItems) ? value.purchasedItems : {},
    history,
    historyDroppedCount:
      Number.isInteger(value.historyDroppedCount) && value.historyDroppedCount >= 0
        ? value.historyDroppedCount + decodedHistory.dropped
        : decodedHistory.dropped,
    nextSeq: Math.max(Number.isInteger(value.nextSeq) ? value.nextSeq : 1, lastSeq + 1),
    spawnCount:
      Number.isInteger(value.spawnCount) && value.spawnCount >= 0 ? value.spawnCount : 0,
    blocked: value.blocked === true,
    newlyUnlocked: value.newlyUnlocked === true,
  };
}

export function decodeSave(record) {
  if (!isPlainObject(record)) {
    throw invalid("it is not a save record");
  }
  if (!Number.isInteger(record.saveVersion) || record.saveVersion < SAVE_VERSION) {
    throw invalid("it has no version");
  }
  if (record.saveVersion > SAVE_VERSION) {
    throw new SaveError(
      "unsupported",
      "This save was made by a newer version of Clickipedia. Reload the page to update the game.",
    );
  }

  let manifest;
  try {
    manifest = validateManifest(record.manifest);
  } catch (cause) {
    throw new SaveError("invalid", `This save cannot be used: ${cause.message}`, { cause });
  }
  if (record.snapshotId !== manifest.snapshotId) {
    throw invalid("it names a different snapshot than its manifest");
  }
  const articleCount = manifest.counts.articles;
  if (record.articleCount !== articleCount) {
    throw invalid("its article count does not match its snapshot");
  }

  let globalVisited;
  try {
    globalVisited = Bitset.fromBytes(articleCount, record.globalVisited);
  } catch (cause) {
    throw new SaveError("invalid", `This save cannot be used: ${cause.message}.`, { cause });
  }
  // The start article is open in every game, and only opened articles can
  // have had their links followed.
  globalVisited.add(manifest.startArticle.ordinal);
  if (!isPlainObject(record.rooms)) {
    throw invalid("its rooms are missing");
  }
  const rooms = Object.fromEntries(
    Object.entries(record.rooms).map(([id, room]) => {
      const decoded = decodeRoom(room, articleCount);
      if (decoded.id !== id) {
        throw invalid("a room has the wrong identifier");
      }
      return [id, decoded];
    }),
  );
  if (!rooms.general) {
    throw invalid("its General room is missing");
  }

  return attachGeneralAliases({
    saveVersion: SAVE_VERSION,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
    savedAt: Number.isFinite(record.savedAt) ? record.savedAt : Date.now(),
    snapshotId: manifest.snapshotId,
    manifestSha256: typeof record.manifestSha256 === "string" ? record.manifestSha256 : undefined,
    manifest,
    globalVisited,
    rooms,
    game: decodeGame(record.game),
  });
}

const BASE64_CHUNK = 0x8000;

export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(text) {
  if (typeof text !== "string") {
    throw invalid("a binary field is missing");
  }
  let binary;
  try {
    binary = atob(text);
  } catch {
    throw invalid("a binary field is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Serializes a record as a JSON document the player can keep as a file.
export function exportSave(record, now = Date.now()) {
  const rooms = Object.fromEntries(
    Object.entries(record.rooms).map(([id, room]) => [
      id,
      {
        ...room,
        visited: room.visited.map((chunk) => ({
          index: chunk.index,
          bytes: bytesToBase64(chunk.bytes),
        })),
        expanded: room.expanded.map((chunk) => ({
          index: chunk.index,
          bytes: bytesToBase64(chunk.bytes),
        })),
      },
    ]),
  );
  return JSON.stringify({
    format: EXPORT_FORMAT,
    exportedAt: new Date(now).toISOString(),
    ...record,
    globalVisited: bytesToBase64(record.globalVisited),
    rooms,
  });
}

// Parses an exported document back into a record, validating it fully.
export function importSave(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw invalid("the file is not JSON");
  }
  if (!isPlainObject(document) || document.format !== EXPORT_FORMAT) {
    throw invalid("the file is not a Clickipedia save");
  }
  const record = {
    ...document,
    globalVisited: base64ToBytes(document.globalVisited),
    rooms: isPlainObject(document.rooms)
      ? Object.fromEntries(
          Object.entries(document.rooms).map(([id, room]) => [
            id,
            {
              ...room,
              visited: Array.isArray(room.visited)
                ? room.visited.map((chunk) => ({
                    index: chunk.index,
                    bytes: base64ToBytes(chunk.bytes),
                  }))
                : room.visited,
              expanded: Array.isArray(room.expanded)
                ? room.expanded.map((chunk) => ({
                    index: chunk.index,
                    bytes: base64ToBytes(chunk.bytes),
                  }))
                : room.expanded,
            },
          ]),
        )
      : document.rooms,
  };
  delete record.format;
  delete record.exportedAt;
  // Round-trip through the live form so the stored record is normalized.
  return encodeSave(decodeSave(record), Number.isFinite(record.savedAt) ? record.savedAt : undefined);
}
