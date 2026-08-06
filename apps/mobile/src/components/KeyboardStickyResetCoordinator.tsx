import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import {
  KeyboardController,
  KeyboardEvents,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";

import { flushMobileDiagnostics, recordMobileDiagnostic } from "../diagnostics/journal";
import {
  KEYBOARD_STICKY_RESET_FOREGROUND_DELAY_MS,
  KEYBOARD_STICKY_RESET_SEND_DELAY_MS,
  KEYBOARD_STICKY_RESET_UNPAIRED_DID_HIDE_DELAY_MS,
  normalizeKeyboardDiagnosticValue,
  resolveKeyboardDidHideAction,
  resolveKeyboardStickyResetDecision,
  resolvePendingKeyboardStickyResetDelay,
  resolveKeyboardStickyResetDelay,
  type KeyboardStickyResetDecision,
} from "../lib/keyboardStickyReset";
import {
  subscribeKeyboardStickyResetRequests,
  type KeyboardStickyResetRequestReason,
} from "../lib/keyboardStickyResetRequests";

type ReconcileTrigger =
  | "message-send-request"
  | "keyboard-will-hide"
  | "keyboard-did-hide"
  | "app-active";
type ReconcileReason =
  | KeyboardStickyResetRequestReason
  | "keyboard-hide"
  | "unpaired-did-hide"
  | "foreground";

interface ReconcilePass {
  readonly generation: number;
  readonly trigger: ReconcileTrigger;
  readonly reason: ReconcileReason;
  readonly delayMs: number;
  readonly durationMs: number | null;
  readonly requireReportedHidden: boolean;
  readonly flushAfter: boolean;
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
 * completion events. Show signals generation-invalidate every pass; send
 * requests provide the deterministic backstop without trusting reported
 * visibility, while generic foreground recovery remains conservative.
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
      recordMobileDiagnostic("keyboard-sticky", {
        event: context.event,
        generation: context.generation,
        trigger: context.trigger,
        reason: context.reason,
        appState: AppState.currentState ?? null,
        height: normalizeKeyboardDiagnosticValue(keyboard.height.value),
        progress: normalizeKeyboardDiagnosticValue(keyboard.progress.value),
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
        keyboardHeight: keyboard.height.value,
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
        keyboard.height.value = 0;
        keyboard.progress.value = 0;
      }
      if (pendingReconcileRef.current === pass) {
        pendingReconcileRef.current = null;
      }
      if (pass.flushAfter) {
        void flushMobileDiagnostics();
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

    const unsubscribeRequests = subscribeKeyboardStickyResetRequests((reason) => {
      const generation = startFreshGeneration();
      recordKeyboardDiagnostic({
        event: "request-received",
        generation,
        trigger: "message-send-request",
        reason,
        decision: "accepted",
      });
      scheduleReconcile(
        {
          generation,
          trigger: "message-send-request",
          reason,
          delayMs: KEYBOARD_STICKY_RESET_SEND_DELAY_MS,
          durationMs: null,
          requireReportedHidden: false,
          flushAfter: true,
        },
        true,
      );
      return true;
    });

    const keyboardWillShow = KeyboardEvents.addListener("keyboardWillShow", (event) => {
      invalidatePendingPasses("keyboard-will-show", event.duration);
    });
    const keyboardDidShow = KeyboardEvents.addListener("keyboardDidShow", (event) => {
      invalidatePendingPasses("keyboard-did-show", event.duration);
    });
    const keyboardWillHide = KeyboardEvents.addListener("keyboardWillHide", (event) => {
      const pending = pendingReconcileRef.current;
      if (
        pending !== null &&
        pending.generation === generationRef.current &&
        pending.reason === "message-send"
      ) {
        const delayMs = resolvePendingKeyboardStickyResetDelay(pending.delayMs, event.duration);
        const extended = delayMs > pending.delayMs;
        recordKeyboardDiagnostic({
          event: "keyboard-will-hide",
          generation: pending.generation,
          trigger: "keyboard-will-hide",
          reason: pending.reason,
          delayMs,
          durationMs: event.duration,
          decision: extended ? "extend-pending" : "preserve-pending",
        });
        if (extended) {
          clearResetTimers();
          scheduleReconcile({ ...pending, delayMs, durationMs: event.duration }, true);
        }
        return;
      }

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
          flushAfter: false,
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

      const generation = startFreshGeneration();
      recordKeyboardDiagnostic({
        event: "keyboard-did-hide",
        generation,
        trigger: "keyboard-did-hide",
        reason: "unpaired-did-hide",
        durationMs: event.duration,
        decision: action,
      });
      scheduleReconcile(
        {
          generation,
          trigger: "keyboard-did-hide",
          reason: "unpaired-did-hide",
          delayMs: KEYBOARD_STICKY_RESET_UNPAIRED_DID_HIDE_DELAY_MS,
          durationMs: event.duration,
          requireReportedHidden: true,
          flushAfter: false,
        },
        true,
      );
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
          flushAfter: false,
        },
        false,
      );
    });

    return () => {
      startFreshGeneration();
      unsubscribeRequests();
      keyboardWillShow.remove();
      keyboardDidShow.remove();
      keyboardWillHide.remove();
      keyboardDidHide.remove();
      appState.remove();
    };
  }, [clearResetTimers, reconcileKeyboardOffset, recordKeyboardDiagnostic, scheduleReconcile]);

  return null;
}
