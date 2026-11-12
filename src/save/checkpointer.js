// Decides when to write the save.
//
// Game state changes many times a second while automation runs, so writes
// are debounced: a checkpoint happens once changes pause for `delayMs`, and
// at least every `maxWaitMs` while they do not pause. `flush` writes at once
// and is used when the page is hidden or closed.
export class Checkpointer {
  constructor({
    save,
    delayMs = 2000,
    maxWaitMs = 10000,
    onError = (error) => console.error("Could not save the game:", error),
    timers = globalThis,
    now = () => Date.now(),
  }) {
    this.save = save;
    this.delayMs = delayMs;
    this.maxWaitMs = maxWaitMs;
    this.onError = onError;
    this.timers = timers;
    this.now = now;
    this.dirty = false;
    this.dirtySince = 0;
    this.timer = null;
    this.writing = null;
    this.disposed = false;
  }

  markDirty() {
    if (this.disposed) {
      return;
    }
    const now = this.now();
    if (!this.dirty) {
      this.dirty = true;
      this.dirtySince = now;
    }
    const deadline = this.dirtySince + this.maxWaitMs;
    const wait = Math.max(0, Math.min(this.delayMs, deadline - now));
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  clearTimer() {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // Writes pending changes now. Writes never overlap: a flush requested
  // during a write waits for it and then writes whatever changed since.
  async flush() {
    this.clearTimer();
    while (this.writing !== null) {
      await this.writing;
    }
    if (!this.dirty || this.disposed) {
      return;
    }
    this.dirty = false;
    this.writing = (async () => {
      try {
        await this.save();
      } catch (error) {
        // Keep the changes pending so the next mutation or flush retries.
        if (!this.dirty) {
          this.dirty = true;
          this.dirtySince = this.now();
        }
        this.onError(error);
      } finally {
        this.writing = null;
      }
    })();
    await this.writing;
  }

  // Stops all future writes, for example before the save is replaced.
  async dispose() {
    this.clearTimer();
    this.disposed = true;
    if (this.writing !== null) {
      await this.writing;
    }
  }
}
