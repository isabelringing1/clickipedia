import { describe, expect, it } from "vitest";

import { expected, readFixtureFiles } from "../testing/fixtureGraph.js";
import {
  EXPORT_FORMAT,
  HISTORY_LIMIT,
  NO_SOURCE,
  PRIORITY_LIMIT,
  SAVE_VERSION,
  SaveError,
  base64ToBytes,
  bytesToBase64,
  createSave,
  decodeSave,
  encodeSave,
  exportSave,
  importSave,
} from "./saveFormat.js";

const files = readFixtureFiles();
const manifest = JSON.parse(
  new TextDecoder().decode(files.get(`snapshots/${expected.snapshotId}/manifest.json`)),
);
const manifestSha256 = "a".repeat(64);

function freshState() {
  return createSave({ manifest: structuredClone(manifest), manifestSha256, now: 1000 });
}

// A game a few moves in: articles 0, 1, 2 open, 0 fully followed.
function playedState() {
  const state = freshState();
  state.visited.add(1);
  state.visited.add(2);
  state.expanded.add(0);
  state.automation.bots[0] = { source: 1, cursor: 2 };
  state.automation.scanCursor = 3;
  state.automation.priority = [2];
  state.automation.credit = 0.4;
  state.game.knowledge = 28;
  state.game.autos = 3;
  state.game.quests = { "quest-1": { complete: true, quest: { id: "quest-1", reward: 25 } } };
  state.game.purchasedItems = { "auto-1": true };
  state.game.history = [
    { seq: 1, kind: "article", ordinal: 1, title: "Cookie_Clicker", spawn: 1 },
    { seq: 2, kind: "quest" },
    { seq: 3, kind: "article", ordinal: 2, title: 'It\'s_a_"Quote"', spawn: 2 },
  ];
  state.game.nextSeq = 4;
  state.game.spawnCount = 2;
  return state;
}

function codeOf(run) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SaveError);
    return error.code;
  }
  return "accepted";
}

describe("createSave", () => {
  it("starts with only the start article open, pinned to the snapshot", () => {
    const state = freshState();
    expect(state.saveVersion).toBe(SAVE_VERSION);
    expect(state.snapshotId).toBe(expected.snapshotId);
    expect(state.manifestSha256).toBe(manifestSha256);
    expect(state.visited.size).toBe(expected.counts.articles);
    expect(state.visited.count).toBe(1);
    expect(state.visited.has(expected.startArticle.ordinal)).toBe(true);
    expect(state.expanded.count).toBe(0);
    expect(state.automation.bots).toEqual([{ source: NO_SOURCE, cursor: 0 }]);
    expect(state.game).toMatchObject({ knowledge: 1, autos: 0, history: [], nextSeq: 1 });
  });
});

describe("encodeSave and decodeSave", () => {
  it("round-trip a game in progress", () => {
    const state = playedState();
    const record = encodeSave(state, 2000);
    expect(record.visited).toBeInstanceOf(Uint8Array);
    expect(record.visitedCount).toBe(3);
    expect(record.savedAt).toBe(2000);
    expect(record.createdAt).toBe(1000);

    const decoded = decodeSave(structuredClone(record));
    expect(decoded.snapshotId).toBe(state.snapshotId);
    expect(decoded.manifest).toEqual(manifest);
    expect(decoded.visited.count).toBe(3);
    expect([0, 1, 2].every((ordinal) => decoded.visited.has(ordinal))).toBe(true);
    expect(decoded.expanded.count).toBe(1);
    expect(decoded.automation).toEqual(state.automation);
    expect(decoded.game).toEqual(state.game);
    expect(encodeSave(decoded, 2000)).toEqual(record);
  });

  it("produces records that do not alias live state", () => {
    const state = playedState();
    const record = encodeSave(state);
    state.visited.add(5);
    state.game.history.push({ seq: 4, kind: "quest" });
    state.automation.bots[0].cursor = 99;
    expect(decodeSave(record).visited.has(5)).toBe(false);
    expect(record.game.history.length).toBe(3);
    expect(record.automation.bots[0].cursor).toBe(2);
  });

  it("rejects records that are not saves", () => {
    const good = encodeSave(playedState());
    const cases = {
      "null": null,
      "array": [],
      "no version": { ...good, saveVersion: undefined },
      "zero version": { ...good, saveVersion: 0 },
      "no manifest": { ...good, manifest: undefined },
      "other snapshot": { ...good, snapshotId: "20990101" },
      "wrong article count": { ...good, articleCount: 11 },
      "short bitset": { ...good, visited: good.visited.slice(0, 1) },
      "long bitset": { ...good, expanded: new Uint8Array(3) },
      "bits past the end": { ...good, visited: new Uint8Array([0xff, 0xff]) },
      "bitset as array": { ...good, visited: [...good.visited] },
      "no game": { ...good, game: undefined },
      "bad knowledge": { ...good, game: { ...good.game, knowledge: "lots" } },
      "infinite knowledge": { ...good, game: { ...good.game, knowledge: Infinity } },
      "negative autos": { ...good, game: { ...good.game, autos: -1 } },
      "fractional autos": { ...good, game: { ...good.game, autos: 1.5 } },
      "no quests": { ...good, game: { ...good.game, quests: null } },
      "history not a list": { ...good, game: { ...good.game, history: {} } },
      "history out of order": {
        ...good,
        game: { ...good.game, history: [good.game.history[1], good.game.history[0]] },
      },
      "history ordinal out of range": {
        ...good,
        game: {
          ...good.game,
          history: [{ seq: 1, kind: "article", ordinal: 10, title: "X", spawn: 1 }],
        },
      },
      "history entry of unknown kind": {
        ...good,
        game: { ...good.game, history: [{ seq: 1, kind: "mystery" }] },
      },
    };
    for (const [label, record] of Object.entries(cases)) {
      expect(codeOf(() => decodeSave(record)), label).toBe("invalid");
    }
    expect(codeOf(() => decodeSave(good))).toBe("accepted");
  });

  it("refuses saves from a newer version instead of misreading them", () => {
    const record = { ...encodeSave(playedState()), saveVersion: SAVE_VERSION + 1 };
    expect(codeOf(() => decodeSave(record))).toBe("unsupported");
  });

  it("rejects a save whose manifest uses an unknown graph format", () => {
    const record = encodeSave(playedState());
    record.manifest = { ...record.manifest, schemaVersion: 2 };
    expect(codeOf(() => decodeSave(record))).toBe("invalid");
  });

  it("repairs automation state that contradicts the bitsets", () => {
    const record = encodeSave(playedState());
    record.automation = {
      // Article 0 is already fully followed; 7 was never opened.
      bots: [{ source: 0, cursor: 1 }, { source: 1, cursor: 0 }],
      scanCursor: 9999,
      priority: [7, 2, 0, -1, "x", 1],
      credit: -5,
    };
    expect(decodeSave(record).automation).toEqual({
      bots: [{ source: NO_SOURCE, cursor: 0 }],
      scanCursor: 0,
      priority: [2, 1],
      credit: 0,
    });

    record.automation = undefined;
    expect(decodeSave(record).automation).toEqual({
      bots: [{ source: NO_SOURCE, cursor: 0 }],
      scanCursor: 0,
      priority: [],
      credit: 0,
    });
  });

  it("keeps the start article open and expanded articles opened", () => {
    const record = encodeSave(playedState());
    record.visited = new Uint8Array([0b0000_0100, 0]);
    record.expanded = new Uint8Array([0b0001_0100, 0]);
    const decoded = decodeSave(record);
    expect(decoded.visited.has(0)).toBe(true);
    expect(decoded.visited.count).toBe(2);
    expect(decoded.expanded.has(2)).toBe(true);
    expect(decoded.expanded.has(4)).toBe(false);
    expect(decoded.expanded.count).toBe(1);
  });

  it("bounds history and the priority queue", () => {
    const state = playedState();
    state.game.history = Array.from({ length: HISTORY_LIMIT + 40 }, (_, index) => ({
      seq: index + 1,
      kind: "article",
      ordinal: 1,
      title: "Cookie_Clicker",
      spawn: index + 1,
    }));
    state.game.nextSeq = 5;
    state.automation.priority = Array.from({ length: PRIORITY_LIMIT + 10 }, () => 2);
    const decoded = decodeSave(encodeSave(state));
    expect(decoded.game.history.length).toBe(HISTORY_LIMIT);
    expect(decoded.game.history[0].seq).toBe(41);
    // nextSeq can never collide with an existing entry.
    expect(decoded.game.nextSeq).toBe(HISTORY_LIMIT + 41);
    expect(decoded.automation.priority.length).toBe(PRIORITY_LIMIT);
  });
});

describe("base64", () => {
  it("round-trips every byte value and large inputs", () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect([...base64ToBytes(bytesToBase64(all))]).toEqual([...all]);
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
    const large = new Uint8Array(900_000).map((_, index) => (index * 31) & 0xff);
    const copy = base64ToBytes(bytesToBase64(large));
    expect(copy.length).toBe(large.length);
    expect(copy.every((byte, index) => byte === large[index])).toBe(true);
  });

  it("rejects invalid input", () => {
    expect(codeOf(() => base64ToBytes("***"))).toBe("invalid");
    expect(codeOf(() => base64ToBytes(undefined))).toBe("invalid");
  });
});

describe("export and import", () => {
  it("round-trips through a JSON document", () => {
    const record = encodeSave(playedState(), 2000);
    const text = exportSave(record, 3000);
    const document = JSON.parse(text);
    expect(document.format).toBe(EXPORT_FORMAT);
    expect(document.snapshotId).toBe(expected.snapshotId);
    expect(typeof document.visited).toBe("string");
    expect(importSave(text)).toEqual(record);
  });

  it("rejects files that are not exported saves", () => {
    const text = exportSave(encodeSave(playedState()));
    const document = JSON.parse(text);
    const cases = {
      "not json": "not json",
      "wrong format": JSON.stringify({ ...document, format: "something-else" }),
      "json array": "[]",
      "missing bitset": JSON.stringify({ ...document, visited: undefined }),
      "bad base64": JSON.stringify({ ...document, visited: "!!!" }),
      "truncated bitset": JSON.stringify({ ...document, visited: "AA==" }),
      "tampered count": JSON.stringify({ ...document, articleCount: 5 }),
    };
    for (const [label, value] of Object.entries(cases)) {
      expect(codeOf(() => importSave(value)), label).toBe("invalid");
    }
    expect(codeOf(() => importSave(JSON.stringify({ ...document, saveVersion: 99 })))).toBe(
      "unsupported",
    );
  });

  it("recomputes counts instead of trusting the file", () => {
    const document = JSON.parse(exportSave(encodeSave(playedState())));
    document.visitedCount = 9_999_999;
    expect(importSave(JSON.stringify(document)).visitedCount).toBe(3);
  });
});
