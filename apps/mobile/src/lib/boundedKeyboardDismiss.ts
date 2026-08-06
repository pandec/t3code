import { KEYBOARD_STICKY_RESET_SEND_DELAY_MS } from "./keyboardStickyReset";

/** Must stay after the deterministic send reconciliation deadline. */
export const POST_SEND_KEYBOARD_DISMISS_MIN_WAIT_MS = KEYBOARD_STICKY_RESET_SEND_DELAY_MS + 80;
/** Bounds lost did-hide completion after the deterministic fallback. */
export const POST_SEND_KEYBOARD_DISMISS_MAX_WAIT_MS = KEYBOARD_STICKY_RESET_SEND_DELAY_MS + 150;

export type BoundedKeyboardDismissOutcome = "settled" | "rejected" | "timeout";

export function requiresKeyboardStickyResetWait(input: {
  readonly reportedVisible: boolean;
  readonly keyboardHeight: number;
}): boolean {
  return (
    !input.reportedVisible &&
    Number.isFinite(input.keyboardHeight) &&
    Math.abs(input.keyboardHeight) > 0.5
  );
}

interface BoundedKeyboardDismissTiming {
  readonly minimumWaitMs?: number;
  readonly maximumWaitMs?: number;
}

export function awaitBoundedKeyboardDismiss(
  dismissPromise: PromiseLike<unknown>,
  timing: BoundedKeyboardDismissTiming = {},
): Promise<BoundedKeyboardDismissOutcome> {
  const minimumWaitMs = Math.max(0, timing.minimumWaitMs ?? POST_SEND_KEYBOARD_DISMISS_MIN_WAIT_MS);
  const maximumWaitMs = Math.max(
    minimumWaitMs,
    timing.maximumWaitMs ?? POST_SEND_KEYBOARD_DISMISS_MAX_WAIT_MS,
  );

  return new Promise((resolve) => {
    let completed = false;
    let minimumWaitElapsed = minimumWaitMs === 0;
    let observedOutcome: Exclude<BoundedKeyboardDismissOutcome, "timeout"> | null = null;

    const finish = (outcome: BoundedKeyboardDismissOutcome) => {
      if (completed) return;
      completed = true;
      clearTimeout(minimumWaitTimer);
      clearTimeout(maximumWaitTimer);
      resolve(outcome);
    };

    const minimumWaitTimer = setTimeout(() => {
      minimumWaitElapsed = true;
      if (observedOutcome !== null) finish(observedOutcome);
    }, minimumWaitMs);
    const maximumWaitTimer = setTimeout(() => finish("timeout"), maximumWaitMs);

    void Promise.resolve(dismissPromise).then(
      () => {
        observedOutcome = "settled";
        if (minimumWaitElapsed) finish(observedOutcome);
      },
      () => {
        // Keep this rejection observer attached even after timeout so a late
        // native rejection never becomes unhandled.
        observedOutcome = "rejected";
        if (minimumWaitElapsed) finish(observedOutcome);
      },
    );
  });
}
