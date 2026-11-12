import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Checkpointer } from "./checkpointer.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(options = {}) {
  const save = vi.fn(async () => {});
  const onError = vi.fn();
  const checkpointer = new Checkpointer({ save, onError, delayMs: 2000, maxWaitMs: 10000, ...options });
  return { save: options.save ?? save, onError, checkpointer };
}

describe("Checkpointer", () => {
  it("does nothing until something changes", async () => {
    const { save, checkpointer } = setup();
    await vi.advanceTimersByTimeAsync(60000);
    await checkpointer.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("writes once after changes pause", async () => {
    const { save, checkpointer } = setup();
    checkpointer.markDirty();
    await vi.advanceTimersByTimeAsync(1000);
    checkpointer.markDirty();
    await vi.advanceTimersByTimeAsync(1999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("writes at least every maxWaitMs under continuous changes", async () => {
    const { save, checkpointer } = setup();
    for (let elapsed = 0; elapsed < 35000; elapsed += 100) {
      checkpointer.markDirty();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("flushes immediately on request and cancels the pending timer", async () => {
    const { save, checkpointer } = setup();
    checkpointer.markDirty();
    await checkpointer.flush();
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("never overlaps writes and saves changes made during a write", async () => {
    let active = 0;
    let maxActive = 0;
    const release = [];
    const save = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => release.push(resolve));
      active -= 1;
    });
    const { checkpointer } = setup({ save });

    checkpointer.markDirty();
    const first = checkpointer.flush();
    checkpointer.markDirty();
    const second = checkpointer.flush();
    const third = checkpointer.flush();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);

    release.shift()();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    release.shift()();
    await Promise.all([second, third]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it("keeps changes pending when a write fails and retries later", async () => {
    let fail = true;
    const save = vi.fn(async () => {
      if (fail) {
        throw new Error("disk full");
      }
    });
    const { checkpointer, onError } = setup({ save });
    checkpointer.markDirty();
    await checkpointer.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(checkpointer.dirty).toBe(true);

    fail = false;
    await checkpointer.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(checkpointer.dirty).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("stops writing once disposed", async () => {
    const { save, checkpointer } = setup();
    checkpointer.markDirty();
    await checkpointer.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    checkpointer.markDirty();
    await checkpointer.flush();
    expect(save).not.toHaveBeenCalled();
  });
});
