import { describe, expect, it } from "vite-plus/test";

import {
  POST_SEND_KEYBOARD_DISMISS_MAX_WAIT_MS,
  POST_SEND_KEYBOARD_DISMISS_MIN_WAIT_MS,
} from "./boundedKeyboardDismiss";
import {
  KEYBOARD_STICKY_RESET_FOREGROUND_DELAY_MS,
  KEYBOARD_STICKY_RESET_SEND_DELAY_MS,
  KEYBOARD_STICKY_RESET_UNPAIRED_DID_HIDE_DELAY_MS,
  normalizeKeyboardDiagnosticValue,
  resolveKeyboardDidHideAction,
  resolveKeyboardStickyResetDecision,
  resolvePendingKeyboardStickyResetDelay,
  resolveKeyboardStickyResetDelay,
} from "./keyboardStickyReset";

describe("keyboard sticky reset", () => {
  it("waits beyond the keyboard animation and bounds invalid durations", () => {
    expect(resolveKeyboardStickyResetDelay(300)).toBe(420);
    expect(resolveKeyboardStickyResetDelay(-20)).toBe(120);
    expect(resolveKeyboardStickyResetDelay(Number.NaN)).toBe(370);
    expect(resolveKeyboardStickyResetDelay(2_000)).toBe(1_120);
  });

  it("orders deterministic recovery before post-send scrolling", () => {
    expect(KEYBOARD_STICKY_RESET_SEND_DELAY_MS).toBe(370);
    expect(POST_SEND_KEYBOARD_DISMISS_MIN_WAIT_MS).toBeGreaterThan(
      KEYBOARD_STICKY_RESET_SEND_DELAY_MS,
    );
    expect(POST_SEND_KEYBOARD_DISMISS_MAX_WAIT_MS).toBe(850);
    expect(POST_SEND_KEYBOARD_DISMISS_MAX_WAIT_MS).toBeGreaterThan(
      POST_SEND_KEYBOARD_DISMISS_MIN_WAIT_MS,
    );
    expect(KEYBOARD_STICKY_RESET_FOREGROUND_DELAY_MS).toBeGreaterThan(
      KEYBOARD_STICKY_RESET_SEND_DELAY_MS,
    );
    expect(KEYBOARD_STICKY_RESET_UNPAIRED_DID_HIDE_DELAY_MS).toBeLessThan(
      KEYBOARD_STICKY_RESET_SEND_DELAY_MS,
    );
  });

  it("extends a send pass beyond a reported longer hide animation", () => {
    expect(resolvePendingKeyboardStickyResetDelay(KEYBOARD_STICKY_RESET_SEND_DELAY_MS, 200)).toBe(
      KEYBOARD_STICKY_RESET_SEND_DELAY_MS,
    );
    expect(resolvePendingKeyboardStickyResetDelay(KEYBOARD_STICKY_RESET_SEND_DELAY_MS, 600)).toBe(
      720,
    );
  });

  it("resets only a stale offset from the active current generation", () => {
    const base = {
      scheduledGeneration: 4,
      currentGeneration: 4,
      keyboardHeight: -336,
      appActive: true,
      reportedVisible: true,
      requireReportedHidden: false,
    } as const;

    expect(resolveKeyboardStickyResetDecision(base)).toBe("reset");
    expect(resolveKeyboardStickyResetDecision({ ...base, currentGeneration: 5 })).toBe(
      "skip-generation",
    );
    expect(resolveKeyboardStickyResetDecision({ ...base, appActive: false })).toBe("skip-inactive");
    expect(resolveKeyboardStickyResetDecision({ ...base, requireReportedHidden: true })).toBe(
      "skip-reported-visible",
    );
    expect(resolveKeyboardStickyResetDecision({ ...base, keyboardHeight: Number.NaN })).toBe(
      "skip-invalid-height",
    );
    expect(resolveKeyboardStickyResetDecision({ ...base, keyboardHeight: -0.25 })).toBe(
      "skip-settled-height",
    );
  });

  it("completes a pending did-hide and delays an unpaired did-hide", () => {
    expect(resolveKeyboardDidHideAction(true)).toBe("complete-pending");
    expect(resolveKeyboardDidHideAction(false)).toBe("schedule-delayed");
  });

  it("normalizes diagnostic values to finite bounded precision", () => {
    expect(normalizeKeyboardDiagnosticValue(-336.126)).toBe(-336.13);
    expect(normalizeKeyboardDiagnosticValue(0.3333)).toBe(0.33);
    expect(normalizeKeyboardDiagnosticValue(50_000)).toBe(10_000);
    expect(normalizeKeyboardDiagnosticValue(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
