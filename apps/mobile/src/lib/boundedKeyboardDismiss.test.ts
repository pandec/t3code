import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  awaitBoundedKeyboardDismiss,
  requiresKeyboardStickyResetWait,
} from "./boundedKeyboardDismiss";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const timing = { minimumWaitMs: 100, maximumWaitMs: 500 } as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("requiresKeyboardStickyResetWait", () => {
  it("waits only for a stale offset reported as hidden", () => {
    expect(requiresKeyboardStickyResetWait({ reportedVisible: false, keyboardHeight: -336 })).toBe(
      true,
    );
    expect(requiresKeyboardStickyResetWait({ reportedVisible: false, keyboardHeight: 0 })).toBe(
      false,
    );
    expect(requiresKeyboardStickyResetWait({ reportedVisible: true, keyboardHeight: -336 })).toBe(
      false,
    );
    expect(
      requiresKeyboardStickyResetWait({
        reportedVisible: false,
        keyboardHeight: Number.NaN,
      }),
    ).toBe(false);
  });
});

describe("awaitBoundedKeyboardDismiss", () => {
  it("holds an immediate settlement until the minimum wait", async () => {
    vi.useFakeTimers();
    const outcome = awaitBoundedKeyboardDismiss(Promise.resolve(), timing);
    let completed = false;
    void outcome.then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe("settled");
  });

  it("allows a known-visible dismiss to settle without a minimum wait", async () => {
    vi.useFakeTimers();
    const outcome = awaitBoundedKeyboardDismiss(Promise.resolve(), {
      minimumWaitMs: 0,
      maximumWaitMs: 500,
    });

    await expect(outcome).resolves.toBe("settled");
  });

  it("returns a normal settlement after the minimum wait", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const outcome = awaitBoundedKeyboardDismiss(gate.promise, timing);

    await vi.advanceTimersByTimeAsync(150);
    gate.resolve();
    await expect(outcome).resolves.toBe("settled");
  });

  it("bounds a never-settling dismiss", async () => {
    vi.useFakeTimers();
    const outcome = awaitBoundedKeyboardDismiss(new Promise(() => {}), timing);

    await vi.advanceTimersByTimeAsync(499);
    let completed = false;
    void outcome.then(() => {
      completed = true;
    });
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe("timeout");
  });

  it("returns rejection after the minimum wait", async () => {
    vi.useFakeTimers();
    const outcome = awaitBoundedKeyboardDismiss(
      Promise.reject(new Error("dismiss failed")),
      timing,
    );

    await vi.advanceTimersByTimeAsync(100);
    await expect(outcome).resolves.toBe("rejected");
  });

  it("consumes a late rejection and completes only once", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const outcome = awaitBoundedKeyboardDismiss(gate.promise, timing);
    const completions: string[] = [];
    void outcome.then((result) => completions.push(result));

    await vi.advanceTimersByTimeAsync(500);
    await expect(outcome).resolves.toBe("timeout");
    expect(completions).toEqual(["timeout"]);

    gate.reject(new Error("late native failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(completions).toEqual(["timeout"]);
  });
});
