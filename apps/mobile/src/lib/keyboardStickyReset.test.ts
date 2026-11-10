import { describe, expect, it } from "vite-plus/test";

import {
  normalizeKeyboardDiagnosticValue,
  resolveKeyboardDidHideAction,
  resolveKeyboardStickyResetDecision,
  resolveKeyboardStickyResetDelay,
} from "./keyboardStickyReset";

describe("keyboard sticky reset", () => {
  it("waits beyond the keyboard animation and bounds invalid durations", () => {
    expect(resolveKeyboardStickyResetDelay(300)).toBe(420);
    expect(resolveKeyboardStickyResetDelay(-20)).toBe(120);
    expect(resolveKeyboardStickyResetDelay(Number.NaN)).toBe(370);
    expect(resolveKeyboardStickyResetDelay(2_000)).toBe(1_120);
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

  it("completes a pending did-hide and ignores an unpaired did-hide", () => {
    expect(resolveKeyboardDidHideAction(true)).toBe("complete-pending");
    expect(resolveKeyboardDidHideAction(false)).toBe("ignore-unpaired");
  });

  it("normalizes diagnostic values to finite bounded precision", () => {
    expect(normalizeKeyboardDiagnosticValue(-336.126)).toBe(-336.13);
    expect(normalizeKeyboardDiagnosticValue(0.3333)).toBe(0.33);
    expect(normalizeKeyboardDiagnosticValue(50_000)).toBe(10_000);
    expect(normalizeKeyboardDiagnosticValue(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
