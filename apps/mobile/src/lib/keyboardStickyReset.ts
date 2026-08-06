const KEYBOARD_STICKY_RESET_SLACK_MS = 120;
const KEYBOARD_STICKY_RESET_DEFAULT_DURATION_MS = 250;
const KEYBOARD_STICKY_RESET_MAX_DURATION_MS = 1_000;

/**
 * Delay before the foreground reconciliation pass. iOS can hide the keyboard
 * while the app is inactive and restore it on return; this window is long
 * enough for that restore to emit `keyboardWillShow`, which invalidates the
 * pass instead of letting it snap the composer down and immediately back up.
 */
export const KEYBOARD_STICKY_RESET_FOREGROUND_DELAY_MS = 400;

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

export function shouldResetKeyboardStickyOffset(input: {
  readonly scheduledGeneration: number;
  readonly currentGeneration: number;
  readonly keyboardHeight: number;
  readonly appActive: boolean;
}): boolean {
  return (
    input.appActive &&
    input.scheduledGeneration === input.currentGeneration &&
    Number.isFinite(input.keyboardHeight) &&
    Math.abs(input.keyboardHeight) > 0.5
  );
}
