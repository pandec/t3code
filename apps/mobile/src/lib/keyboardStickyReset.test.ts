import { describe, expect, it } from "vite-plus/test";

import {
  KEYBOARD_STICKY_RESET_FOREGROUND_DELAY_MS,
  resolveKeyboardStickyResetDelay,
  shouldResetKeyboardStickyOffset,
} from "./keyboardStickyReset";

describe("keyboard sticky reset", () => {
  it("waits beyond the keyboard animation and bounds invalid durations", () => {
    expect(resolveKeyboardStickyResetDelay(300)).toBe(420);
    expect(resolveKeyboardStickyResetDelay(-20)).toBe(120);
    expect(resolveKeyboardStickyResetDelay(Number.NaN)).toBe(370);
    expect(resolveKeyboardStickyResetDelay(2_000)).toBe(1_120);
  });

  it("leaves the foreground pass long enough for a restored keyboard to cancel it", () => {
    expect(KEYBOARD_STICKY_RESET_FOREGROUND_DELAY_MS).toBeGreaterThan(
      resolveKeyboardStickyResetDelay(250),
    );
  });

  it("resets only a stale offset from the current hide generation", () => {
    expect(
      shouldResetKeyboardStickyOffset({
        scheduledGeneration: 4,
        currentGeneration: 4,
        keyboardHeight: -336,
        appActive: true,
      }),
    ).toBe(true);
    expect(
      shouldResetKeyboardStickyOffset({
        scheduledGeneration: 4,
        currentGeneration: 5,
        keyboardHeight: -336,
        appActive: true,
      }),
    ).toBe(false);
    expect(
      shouldResetKeyboardStickyOffset({
        scheduledGeneration: 4,
        currentGeneration: 4,
        keyboardHeight: 0,
        appActive: true,
      }),
    ).toBe(false);
    expect(
      shouldResetKeyboardStickyOffset({
        scheduledGeneration: 4,
        currentGeneration: 4,
        keyboardHeight: -336,
        appActive: false,
      }),
    ).toBe(false);
    expect(
      shouldResetKeyboardStickyOffset({
        scheduledGeneration: 4,
        currentGeneration: 4,
        keyboardHeight: Number.NaN,
        appActive: true,
      }),
    ).toBe(false);
    expect(
      shouldResetKeyboardStickyOffset({
        scheduledGeneration: 4,
        currentGeneration: 4,
        keyboardHeight: -0.25,
        appActive: true,
      }),
    ).toBe(false);
  });
});
