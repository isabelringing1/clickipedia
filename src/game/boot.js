// Starts the game in a browser tab.

import { openPlayerStore } from "../save/playerStore.js";
import { graphBaseUrl } from "../wikiGraph/config.js";
import { startSession } from "./session.js";

const TAB_LOCK = "clickipedia-save";

export class BootError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BootError";
    this.code = code;
  }
}

// Two tabs writing one save would overwrite each other's progress, so only
// the first tab gets to play. The lock is released when its tab closes.
function acquireTabLock() {
  if (!globalThis.navigator?.locks) {
    return Promise.resolve(true);
  }
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(TAB_LOCK, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        // Holding the lock means never settling this promise.
        return lock === null ? undefined : new Promise(() => {});
      })
      .catch(reject);
  });
}

let lockHeld = false;

export async function bootGame() {
  if (!lockHeld) {
    lockHeld = await acquireTabLock();
    if (!lockHeld) {
      throw new BootError(
        "other-tab",
        "Clickipedia is already open in another tab. Close that tab, then reload this one.",
      );
    }
  }
  const store = await openPlayerStore();
  try {
    return await startSession({ baseUrl: graphBaseUrl(), store });
  } catch (error) {
    // Hand the store over so the error screen can offer to reset the save.
    error.store = store;
    throw error;
  }
}
