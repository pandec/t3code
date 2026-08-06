const KEYBOARD_STICKY_RESET_SLACK_MS = 120;
const KEYBOARD_STICKY_RESET_DEFAULT_DURATION_MS = 250;
const KEYBOARD_STICKY_RESET_MAX_DURATION_MS = 1_000;
const KEYBOARD_DIAGNOSTIC_MAX_ABS_VALUE = 10_000;

/**
 * How long to wait after `keyboardWillHide` before treating a non-zero
 * keyboard offset as stale. `durationMs` is the iOS keyboard animation
 * duration in milliseconds, as reported by the keyboard event.
 */
export function resolveKeyboardStickyResetDelay(durationMs: number): number {
  const normalizedDuration = Number.isFinite(durationMs)
    ? Math.min(Math.max(0, durationMs), KEYBOARD_STICKY_RESET_MAX_DURATION_MS)
    : KEYBOARD_STICKY_RESET_DEFAULT_DURATION_MS;
  return normalizedDuration + KEYBOARD_STICKY_RESET_SLACK_MS;
}

/** The deterministic send pass must run before post-send scrolling may start. */
export const KEYBOARD_STICKY_RESET_SEND_DELAY_MS = resolveKeyboardStickyResetDelay(
  KEYBOARD_STICKY_RESET_DEFAULT_DURATION_MS,
);

/**
 * Delay before the foreground reconciliation pass. iOS can hide the keyboard
 * while the app is inactive and restore it on return; this window is long
 * enough for that restore to emit `keyboardWillShow`, which invalidates the
 * pass instead of letting it snap the composer down and immediately back up.
 */
export const KEYBOARD_STICKY_RESET_FOREGROUND_DELAY_MS = 400;

/** Gives a new show signal a chance to invalidate a wholly unpaired did-hide. */
export const KEYBOARD_STICKY_RESET_UNPAIRED_DID_HIDE_DELAY_MS = 80;

export function resolvePendingKeyboardStickyResetDelay(
  pendingDelayMs: number,
  hideDurationMs: number,
): number {
  return Math.max(pendingDelayMs, resolveKeyboardStickyResetDelay(hideDurationMs));
}

export type KeyboardStickyResetDecision =
  | "reset"
  | "skip-generation"
  | "skip-inactive"
  | "skip-reported-visible"
  | "skip-invalid-height"
  | "skip-settled-height";

export function resolveKeyboardStickyResetDecision(input: {
  readonly scheduledGeneration: number;
  readonly currentGeneration: number;
  readonly keyboardHeight: number;
  readonly appActive: boolean;
  readonly reportedVisible: boolean;
  readonly requireReportedHidden: boolean;
}): KeyboardStickyResetDecision {
  if (input.scheduledGeneration !== input.currentGeneration) return "skip-generation";
  if (!input.appActive) return "skip-inactive";
  if (input.requireReportedHidden && input.reportedVisible) return "skip-reported-visible";
  if (!Number.isFinite(input.keyboardHeight)) return "skip-invalid-height";
  if (Math.abs(input.keyboardHeight) <= 0.5) return "skip-settled-height";
  return "reset";
}

export type KeyboardDidHideAction = "complete-pending" | "schedule-delayed";

export function resolveKeyboardDidHideAction(hasPendingReconcile: boolean): KeyboardDidHideAction {
  return hasPendingReconcile ? "complete-pending" : "schedule-delayed";
}

export function normalizeKeyboardDiagnosticValue(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const bounded = Math.min(
    Math.max(value, -KEYBOARD_DIAGNOSTIC_MAX_ABS_VALUE),
    KEYBOARD_DIAGNOSTIC_MAX_ABS_VALUE,
  );
  return Math.round(bounded * 100) / 100;
}
