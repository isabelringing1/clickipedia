// Where the save record lives: one IndexedDB object store holding one record.
//
// IndexedDB stores typed arrays natively, so the visited bitset is written as
// binary rather than JSON, and a write replaces the whole record in a single
// transaction: a save is never half old and half new.

import { SaveError } from "./saveFormat.js";

export const DB_NAME = "clickipedia";
// Version of the database layout (object stores), not of the save record.
export const DB_VERSION = 1;
const STORE = "saves";
const CURRENT = "current";

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException("Transaction aborted", "AbortError"));
  });
}

export class PlayerStore {
  constructor(database) {
    this.database = database;
    this.persistent = true;
  }

  static async open({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
    if (!indexedDB) {
      throw new SaveError("unavailable", "This browser does not provide IndexedDB.");
    }
    let database;
    try {
      const request = indexedDB.open(name, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      database = await requestToPromise(request);
    } catch (cause) {
      throw new SaveError("unavailable", "The save database could not be opened.", { cause });
    }
    // Let a newer version of the game upgrade the database in another tab.
    database.onversionchange = () => database.close();
    return new PlayerStore(database);
  }

  // Returns the stored record, or null when there is no save.
  async load() {
    const transaction = this.database.transaction(STORE, "readonly");
    const record = await requestToPromise(transaction.objectStore(STORE).get(CURRENT));
    return record ?? null;
  }

  async write(record) {
    const transaction = this.database.transaction(STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE).put(record, CURRENT);
    await done;
  }

  async clear() {
    const transaction = this.database.transaction(STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE).delete(CURRENT);
    await done;
  }

  close() {
    this.database.close();
  }
}

// Stands in when IndexedDB is unavailable (some private-browsing modes), so
// the game is playable for the session even though nothing is kept.
export class MemoryStore {
  constructor() {
    this.record = null;
    this.persistent = false;
  }

  async load() {
    return this.record === null ? null : structuredClone(this.record);
  }

  async write(record) {
    this.record = structuredClone(record);
  }

  async clear() {
    this.record = null;
  }

  close() {}
}

export async function openPlayerStore(options) {
  try {
    return await PlayerStore.open(options);
  } catch (error) {
    if (error instanceof SaveError && error.code === "unavailable") {
      console.warn(`${error.message} Progress will not be saved.`);
      return new MemoryStore();
    }
    throw error;
  }
}
