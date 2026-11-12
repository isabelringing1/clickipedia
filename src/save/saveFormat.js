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
import { Bitset } from "./bitset.js";

export const SAVE_VERSION = 1;
export const EXPORT_FORMAT = "clickipedia-save";

export const HISTORY_LIMIT = 100;
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

// A new game on the given snapshot: only the start article is open.
export function createSave({ manifest, manifestSha256, now = Date.now() }) {
  validateManifest(manifest);
  const articleCount = manifest.counts.articles;
  const visited = new Bitset(articleCount);
  visited.add(manifest.startArticle.ordinal);
  return {
    saveVersion: SAVE_VERSION,
    createdAt: now,
    savedAt: now,
    snapshotId: manifest.snapshotId,
    manifestSha256,
    manifest,
    visited,
    expanded: new Bitset(articleCount),
    automation: {
      bots: [idleBot()],
      scanCursor: 0,
      priority: [],
      credit: 0,
    },
    game: {
      knowledge: 1,
      autos: 0,
      quests: {},
      purchasedItems: {},
      history: [],
      nextSeq: 1,
      spawnCount: 0,
    },
  };
}

export function encodeSave(state, now = Date.now()) {
  return {
    saveVersion: SAVE_VERSION,
    createdAt: state.createdAt,
    savedAt: now,
    snapshotId: state.snapshotId,
    manifestSha256: state.manifestSha256,
    manifest: state.manifest,
    articleCount: state.visited.size,
    visitedCount: state.visited.count,
    visited: state.visited.toBytes(),
    expanded: state.expanded.toBytes(),
    automation: {
      bots: state.automation.bots.map(({ source, cursor }) => ({ source, cursor })),
      scanCursor: state.automation.scanCursor,
      priority: [...state.automation.priority],
      credit: state.automation.credit,
    },
    game: {
      knowledge: state.game.knowledge,
      autos: state.game.autos,
      quests: state.game.quests,
      purchasedItems: state.game.purchasedItems,
      history: state.game.history.map((entry) => ({ ...entry })),
      nextSeq: state.game.nextSeq,
      spawnCount: state.game.spawnCount,
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
      history.push({ seq: entry.seq, kind: "quest" });
    } else if (
      entry.kind === "article" &&
      isOrdinal(entry.ordinal, articleCount) &&
      typeof entry.title === "string" &&
      entry.title !== ""
    ) {
      history.push({
        seq: entry.seq,
        kind: "article",
        ordinal: entry.ordinal,
        title: entry.title,
        spawn: Number.isInteger(entry.spawn) && entry.spawn > 0 ? entry.spawn : 1,
      });
    } else {
      throw invalid("its history has an unreadable entry");
    }
  }
  return history.slice(-HISTORY_LIMIT);
}

function decodeGame(value, articleCount) {
  if (!isPlainObject(value)) {
    throw invalid("its game progress is missing");
  }
  if (!Number.isFinite(value.knowledge)) {
    throw invalid("its knowledge is not a number");
  }
  if (!Number.isInteger(value.autos) || value.autos < 0) {
    throw invalid("its auto-opener count is not a whole number");
  }
  if (!isPlainObject(value.quests) || !isPlainObject(value.purchasedItems)) {
    throw invalid("its quests or purchases are missing");
  }
  const history = decodeHistory(value.history, articleCount);
  const lastSeq = history.length > 0 ? history[history.length - 1].seq : 0;
  return {
    knowledge: value.knowledge,
    autos: value.autos,
    quests: value.quests,
    purchasedItems: value.purchasedItems,
    history,
    nextSeq: Math.max(Number.isInteger(value.nextSeq) ? value.nextSeq : 1, lastSeq + 1),
    spawnCount: Number.isInteger(value.spawnCount) && value.spawnCount >= 0 ? value.spawnCount : 0,
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

export function decodeSave(record) {
  if (!isPlainObject(record)) {
    throw invalid("it is not a save record");
  }
  if (!Number.isInteger(record.saveVersion) || record.saveVersion < 1) {
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

  let visited;
  let expanded;
  try {
    visited = Bitset.fromBytes(articleCount, record.visited);
    expanded = Bitset.fromBytes(articleCount, record.expanded);
  } catch (cause) {
    throw new SaveError("invalid", `This save cannot be used: ${cause.message}.`, { cause });
  }
  // The start article is open in every game, and only opened articles can
  // have had their links followed.
  visited.add(manifest.startArticle.ordinal);
  expanded.intersectWith(visited);

  return {
    saveVersion: SAVE_VERSION,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
    savedAt: Number.isFinite(record.savedAt) ? record.savedAt : Date.now(),
    snapshotId: manifest.snapshotId,
    manifestSha256: typeof record.manifestSha256 === "string" ? record.manifestSha256 : undefined,
    manifest,
    visited,
    expanded,
    automation: decodeAutomation(record.automation, visited, expanded),
    game: decodeGame(record.game, articleCount),
  };
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
  return JSON.stringify({
    format: EXPORT_FORMAT,
    exportedAt: new Date(now).toISOString(),
    ...record,
    visited: bytesToBase64(record.visited),
    expanded: bytesToBase64(record.expanded),
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
    visited: base64ToBytes(document.visited),
    expanded: base64ToBytes(document.expanded),
  };
  delete record.format;
  delete record.exportedAt;
  // Round-trip through the live form so the stored record is normalized.
  return encodeSave(decodeSave(record), Number.isFinite(record.savedAt) ? record.savedAt : undefined);
}
