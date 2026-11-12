import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import { MemoryStore, PlayerStore, openPlayerStore } from "./playerStore.js";
import { SaveError } from "./saveFormat.js";

function sampleRecord(extra = {}) {
  return {
    saveVersion: 1,
    snapshotId: "20260101",
    visited: new Uint8Array([1, 2, 3, 255]),
    game: { knowledge: 5, history: [{ seq: 1, kind: "quest" }] },
    ...extra,
  };
}

describe("PlayerStore", () => {
  it("has no save in a new database", async () => {
    const store = await PlayerStore.open({ indexedDB: new IDBFactory() });
    expect(store.persistent).toBe(true);
    expect(await store.load()).toBeNull();
    store.close();
  });

  it("stores binary state and survives reopening", async () => {
    const indexedDB = new IDBFactory();
    const first = await PlayerStore.open({ indexedDB });
    await first.write(sampleRecord());
    first.close();

    const second = await PlayerStore.open({ indexedDB });
    const loaded = await second.load();
    expect(loaded.visited).toBeInstanceOf(Uint8Array);
    expect(loaded).toEqual(sampleRecord());
    second.close();
  });

  it("replaces the whole record on each write", async () => {
    const store = await PlayerStore.open({ indexedDB: new IDBFactory() });
    await store.write(sampleRecord({ leftover: true }));
    await store.write(sampleRecord({ game: { knowledge: 9, history: [] } }));
    const loaded = await store.load();
    expect(loaded.leftover).toBeUndefined();
    expect(loaded.game).toEqual({ knowledge: 9, history: [] });
  });

  it("stores a copy, not a reference to live data", async () => {
    const store = await PlayerStore.open({ indexedDB: new IDBFactory() });
    const record = sampleRecord();
    await store.write(record);
    record.visited[0] = 77;
    record.game.knowledge = 1000;
    expect(await store.load()).toEqual(sampleRecord());
  });

  it("clears the save", async () => {
    const indexedDB = new IDBFactory();
    const store = await PlayerStore.open({ indexedDB });
    await store.write(sampleRecord());
    await store.clear();
    expect(await store.load()).toBeNull();
    store.close();
    expect(await (await PlayerStore.open({ indexedDB })).load()).toBeNull();
  });

  it("keeps separate databases separate", async () => {
    const indexedDB = new IDBFactory();
    const a = await PlayerStore.open({ indexedDB, name: "a" });
    const b = await PlayerStore.open({ indexedDB, name: "b" });
    await a.write(sampleRecord());
    expect(await b.load()).toBeNull();
  });

  it("fails a write that cannot be stored instead of reporting success", async () => {
    const store = await PlayerStore.open({ indexedDB: new IDBFactory() });
    await store.write(sampleRecord());
    await expect(store.write({ unclonable: () => {} })).rejects.toThrow();
    expect(await store.load()).toEqual(sampleRecord());
  });

  it("reports an unavailable database", async () => {
    await expect(PlayerStore.open({ indexedDB: null })).rejects.toMatchObject({
      name: "SaveError",
      code: "unavailable",
    });
    const broken = {
      open() {
        throw new DOMException("denied", "SecurityError");
      },
    };
    const error = await PlayerStore.open({ indexedDB: broken }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SaveError);
    expect(error.code).toBe("unavailable");
  });
});

describe("openPlayerStore", () => {
  it("falls back to memory when IndexedDB is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await openPlayerStore({ indexedDB: null });
    expect(store).toBeInstanceOf(MemoryStore);
    expect(store.persistent).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();

    expect(await store.load()).toBeNull();
    const record = sampleRecord();
    await store.write(record);
    record.visited[0] = 77;
    expect(await store.load()).toEqual(sampleRecord());
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("uses IndexedDB when it works", async () => {
    const store = await openPlayerStore({ indexedDB: new IDBFactory() });
    expect(store).toBeInstanceOf(PlayerStore);
  });
});
