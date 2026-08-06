import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import {
  KeyboardController,
  KeyboardEvents,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";

import {
  KEYBOARD_STICKY_RESET_FOREGROUND_DELAY_MS,
  resolveKeyboardStickyResetDelay,
  shouldResetKeyboardStickyOffset,
} from "../lib/keyboardStickyReset";

/**
 * Recovers the shared keyboard offset when iOS drops the terminal keyboard
 * movement event.
 *
 * `KeyboardProvider` only writes its reanimated `height`/`progress` values from
 * `onKeyboardMoveStart` (and interactive moves) on iOS — `onKeyboardMoveEnd` is
 * Android-only there. So a dropped or clobbered hide-start event leaves the
 * shared height parked at `-keyboardHeight` with nothing to correct it, and
 * every consumer of that value (the `KeyboardStickyView` composers on the
 * thread/terminal/review surfaces, the new-task editor inset) stays lifted.
 *
 * The `keyboardWillHide` / `keyboardDidHide` notifications travel on a
 * different channel than the movement events, so they survive when the movement
 * event does not. This coordinator listens on that channel and zeroes the
 * shared values only once the keyboard is provably gone and the offset is still
 * stale. iOS only; Android drives the values from `onKeyboardMove`/`MoveEnd`.
 */
export function KeyboardStickyResetCoordinator() {
  const keyboard = useReanimatedKeyboardAnimation();
  const generationRef = useRef(0);
  const pendingHideGenerationRef = useRef<number | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  const reconcileKeyboardOffset = useCallback(
    (scheduledGeneration: number, requireReportedHidden: boolean) => {
      // Only the foreground pass consults `isVisible()`. On the hide path it
      // would be counter-productive: the module flips `isVisible()` to false on
      // `keyboardDidHide`, so requiring it there would disable exactly the
      // backstop that matters when `keyboardDidHide` itself never arrives.
      if (requireReportedHidden && KeyboardController.isVisible()) {
        return;
      }

      if (
        shouldResetKeyboardStickyOffset({
          scheduledGeneration,
          currentGeneration: generationRef.current,
          keyboardHeight: keyboard.height.value,
          appActive: AppState.currentState === "active",
        })
      ) {
        keyboard.height.value = 0;
        keyboard.progress.value = 0;
      }

      if (pendingHideGenerationRef.current === scheduledGeneration) {
        pendingHideGenerationRef.current = null;
      }
    },
    [keyboard.height, keyboard.progress],
  );

  const scheduleReconcile = useCallback(
    (generation: number, delayMs: number, requireReportedHidden: boolean) => {
      clearResetTimer();
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        reconcileKeyboardOffset(generation, requireReportedHidden);
      }, delayMs);
    },
    [clearResetTimer, reconcileKeyboardOffset],
  );

  useEffect(() => {
    if (Platform.OS !== "ios") {
      return;
    }

    // Any show signal invalidates every scheduled pass: bumping the generation
    // makes an already-running timer callback a no-op even if it fires between
    // `clearTimeout` and the next tick.
    const cancelPendingReset = () => {
      generationRef.current += 1;
      pendingHideGenerationRef.current = null;
      clearResetTimer();
    };

    const keyboardWillShow = KeyboardEvents.addListener("keyboardWillShow", cancelPendingReset);
    // `keyboardWillShow` is suppressed while the native events-ignorer is armed
    // (keyboard extenders, `dismiss({ keepFocus })`); `keyboardDidShow` is not.
    const keyboardDidShow = KeyboardEvents.addListener("keyboardDidShow", cancelPendingReset);
    const keyboardWillHide = KeyboardEvents.addListener("keyboardWillHide", (event) => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      pendingHideGenerationRef.current = generation;
      scheduleReconcile(generation, resolveKeyboardStickyResetDelay(event.duration), false);
    });
    const keyboardDidHide = KeyboardEvents.addListener("keyboardDidHide", () => {
      // Gated on a pending hide so a late/duplicate `didHide` that trails a new
      // `willShow` cannot zero a keyboard that is on its way up.
      const generation = pendingHideGenerationRef.current;
      if (generation === null) {
        return;
      }
      clearResetTimer();
      reconcileKeyboardOffset(generation, false);
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active" || KeyboardController.isVisible()) {
        return;
      }
      // Deferred rather than immediate: if iOS is restoring a keyboard it hid
      // while we were inactive, its `keyboardWillShow` lands inside this window
      // and cancels the pass, so the composer never snaps down and back up.
      scheduleReconcile(generationRef.current, KEYBOARD_STICKY_RESET_FOREGROUND_DELAY_MS, true);
    });

    return () => {
      clearResetTimer();
      pendingHideGenerationRef.current = null;
      keyboardWillShow.remove();
      keyboardDidShow.remove();
      keyboardWillHide.remove();
      keyboardDidHide.remove();
      appState.remove();
    };
  }, [clearResetTimer, reconcileKeyboardOffset, scheduleReconcile]);

  return null;
}
