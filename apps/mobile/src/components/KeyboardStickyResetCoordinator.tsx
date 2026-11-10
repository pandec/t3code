import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import {
  KeyboardController,
  KeyboardEvents,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";

import { mobileDiagnosticsEnabled, recordMobileDiagnostic } from "../diagnostics/journal";
import {
  KEYBOARD_STICKY_RESET_FOREGROUND_DELAY_MS,
  normalizeKeyboardDiagnosticValue,
  resolveKeyboardDidHideAction,
  resolveKeyboardStickyResetDecision,
  resolveKeyboardStickyResetDelay,
  type KeyboardStickyResetDecision,
} from "../lib/keyboardStickyReset";

type ReconcileTrigger = "keyboard-will-hide" | "keyboard-did-hide" | "app-active";
type ReconcileReason = "keyboard-hide" | "foreground";

interface ReconcilePass {
  readonly generation: number;
  readonly trigger: ReconcileTrigger;
  readonly reason: ReconcileReason;
  readonly delayMs: number;
  readonly durationMs: number | null;
  readonly requireReportedHidden: boolean;
}

interface KeyboardDiagnosticContext {
  readonly event: string;
  readonly generation: number;
  readonly trigger: string;
  readonly reason: string | null;
  readonly delayMs?: number | null;
  readonly durationMs?: number | null;
  readonly decision: string;
  readonly reset?: boolean | null;
}

/**
 * Recovers the shared keyboard offset when iOS drops keyboard movement or hide
 * completion events. Show signals generation-invalidate every pass;
 * foreground recovery remains conservative.
 */
export function KeyboardStickyResetCoordinator() {
  const keyboard = useReanimatedKeyboardAnimation();
  const generationRef = useRef(0);
  const pendingReconcileRef = useRef<ReconcilePass | null>(null);
  const resetTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());

  const clearResetTimers = useCallback(() => {
    resetTimersRef.current.forEach((timer) => clearTimeout(timer));
    resetTimersRef.current.clear();
  }, []);

  const recordKeyboardDiagnostic = useCallback(
    (context: KeyboardDiagnosticContext) => {
      if (!mobileDiagnosticsEnabled) return;
      recordMobileDiagnostic("keyboard-sticky", {
        event: context.event,
        generation: context.generation,
        trigger: context.trigger,
        reason: context.reason,
        appState: AppState.currentState ?? null,
        height: normalizeKeyboardDiagnosticValue(keyboard.height.get()),
        progress: normalizeKeyboardDiagnosticValue(keyboard.progress.get()),
        reportedVisible: KeyboardController.isVisible(),
        delayMs:
          context.delayMs === undefined || context.delayMs === null
            ? null
            : normalizeKeyboardDiagnosticValue(context.delayMs),
        durationMs:
          context.durationMs === undefined || context.durationMs === null
            ? null
            : normalizeKeyboardDiagnosticValue(context.durationMs),
        decision: context.decision,
        reset: context.reset ?? null,
      });
    },
    [keyboard.height, keyboard.progress],
  );

  const reconcileKeyboardOffset = useCallback(
    (pass: ReconcilePass, trigger: ReconcileTrigger) => {
      const reportedVisible = KeyboardController.isVisible();
      const decision: KeyboardStickyResetDecision = resolveKeyboardStickyResetDecision({
        scheduledGeneration: pass.generation,
        currentGeneration: generationRef.current,
        keyboardHeight: keyboard.height.get(),
        appActive: AppState.currentState === "active",
        reportedVisible,
        requireReportedHidden: pass.requireReportedHidden,
      });
      const reset = decision === "reset";

      // Record the stale values before resetting them so device diagnostics
      // preserve the evidence that drove the decision.
      recordKeyboardDiagnostic({
        event: "reconcile",
        generation: pass.generation,
        trigger,
        reason: pass.reason,
        delayMs: pass.delayMs,
        durationMs: pass.durationMs,
        decision,
        reset,
      });
      if (reset) {
        keyboard.height.set(0);
        keyboard.progress.set(0);
      }
      if (pendingReconcileRef.current === pass) {
        pendingReconcileRef.current = null;
      }
    },
    [keyboard.height, keyboard.progress, recordKeyboardDiagnostic],
  );

  const scheduleReconcile = useCallback(
    (pass: ReconcilePass, pending: boolean) => {
      if (pending) pendingReconcileRef.current = pass;
      recordKeyboardDiagnostic({
        event: "schedule",
        generation: pass.generation,
        trigger: pass.trigger,
        reason: pass.reason,
        delayMs: pass.delayMs,
        durationMs: pass.durationMs,
        decision: "scheduled",
      });

      const timer = setTimeout(() => {
        resetTimersRef.current.delete(timer);
        reconcileKeyboardOffset(pass, pass.trigger);
      }, pass.delayMs);
      resetTimersRef.current.add(timer);
    },
    [reconcileKeyboardOffset, recordKeyboardDiagnostic],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to native keyboard, and AppState events
  useEffect(() => {
    if (Platform.OS !== "ios") return;

    const startFreshGeneration = () => {
      generationRef.current += 1;
      pendingReconcileRef.current = null;
      clearResetTimers();
      return generationRef.current;
    };

    const invalidatePendingPasses = (
      trigger: "keyboard-will-show" | "keyboard-did-show",
      durationMs: number,
    ) => {
      const generation = startFreshGeneration();
      recordKeyboardDiagnostic({
        event: trigger,
        generation,
        trigger,
        reason: null,
        durationMs,
        decision: "invalidate",
      });
    };

    const keyboardWillShow = KeyboardEvents.addListener("keyboardWillShow", (event) => {
      invalidatePendingPasses("keyboard-will-show", event.duration);
    });
    const keyboardDidShow = KeyboardEvents.addListener("keyboardDidShow", (event) => {
      invalidatePendingPasses("keyboard-did-show", event.duration);
    });
    const keyboardWillHide = KeyboardEvents.addListener("keyboardWillHide", (event) => {
      const generation = startFreshGeneration();
      recordKeyboardDiagnostic({
        event: "keyboard-will-hide",
        generation,
        trigger: "keyboard-will-hide",
        reason: "keyboard-hide",
        durationMs: event.duration,
        decision: "new-generation",
      });
      scheduleReconcile(
        {
          generation,
          trigger: "keyboard-will-hide",
          reason: "keyboard-hide",
          delayMs: resolveKeyboardStickyResetDelay(event.duration),
          durationMs: event.duration,
          requireReportedHidden: false,
        },
        true,
      );
    });
    const keyboardDidHide = KeyboardEvents.addListener("keyboardDidHide", (event) => {
      const pending = pendingReconcileRef.current;
      const action = resolveKeyboardDidHideAction(
        pending !== null && pending.generation === generationRef.current,
      );

      if (action === "complete-pending" && pending !== null) {
        recordKeyboardDiagnostic({
          event: "keyboard-did-hide",
          generation: pending.generation,
          trigger: "keyboard-did-hide",
          reason: pending.reason,
          durationMs: event.duration,
          decision: action,
        });
        clearResetTimers();
        reconcileKeyboardOffset(pending, "keyboard-did-hide");
        return;
      }

      recordKeyboardDiagnostic({
        event: "keyboard-did-hide",
        generation: generationRef.current,
        trigger: "keyboard-did-hide",
        reason: "unpaired-did-hide",
        durationMs: event.duration,
        decision: action,
      });
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const generation = generationRef.current;
      recordKeyboardDiagnostic({
        event: "app-active",
        generation,
        trigger: "app-active",
        reason: "foreground",
        delayMs: KEYBOARD_STICKY_RESET_FOREGROUND_DELAY_MS,
        decision: "attempt",
      });
      scheduleReconcile(
        {
          generation,
          trigger: "app-active",
          reason: "foreground",
          delayMs: KEYBOARD_STICKY_RESET_FOREGROUND_DELAY_MS,
          durationMs: null,
          requireReportedHidden: true,
        },
        false,
      );
    });

    return () => {
      startFreshGeneration();
      keyboardWillShow.remove();
      keyboardDidShow.remove();
      keyboardWillHide.remove();
      keyboardDidHide.remove();
      appState.remove();
    };
  }, [clearResetTimers, reconcileKeyboardOffset, recordKeyboardDiagnostic, scheduleReconcile]);

  return null;
}
