import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { KeyboardController } from "react-native-keyboard-controller";

import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import {
  sheetPresentationPhaseAfterEvent,
  type SheetPresentationEvent,
  type SheetPresentationPhase,
} from "./thread-settings-sheet-state";

export type ThreadSettingsSheetCloseReason = "save" | "dismiss";

/**
 * Keeps the custom native composer and the settings modal from owning focus at
 * the same time. Opening waits for the keyboard dismissal to finish, while
 * focus restoration waits for the modal's dismissal callback.
 *
 * Phase changes run through the pure transition table, which makes
 * `onDismissed` idempotent: the sheet reports dismissal from Modal.onDismiss,
 * its Android visibility effect, and its unmount cleanup, and any of them may
 * fire first (or not at all) for a given presentation.
 */
export function useThreadSettingsSheetPresentation(input: {
  readonly editorRef: RefObject<ComposerEditorHandle | null>;
  readonly isEditorFocused: boolean;
}) {
  const [phase, setPhase] = useState<SheetPresentationPhase>("closed");
  const phaseRef = useRef<SheetPresentationPhase>("closed");
  const isActiveRef = useRef(false);
  const isMountedRef = useRef(true);
  const openingIdRef = useRef(0);
  const restoreFocusOnSaveRef = useRef(false);
  const shouldRestoreAfterDismissRef = useRef(false);

  const applyEvent = useCallback((event: SheetPresentationEvent): SheetPresentationPhase | null => {
    const next = sheetPresentationPhaseAfterEvent(phaseRef.current, event);
    if (next !== null) {
      phaseRef.current = next;
      isActiveRef.current = next !== "closed";
      setPhase(next);
    }
    return next;
  }, []);

  useEffect(
    () => () => {
      isMountedRef.current = false;
      isActiveRef.current = false;
      openingIdRef.current += 1;
    },
    [],
  );

  const open = useCallback(() => {
    if (applyEvent("open") === null) {
      return;
    }

    restoreFocusOnSaveRef.current = input.isEditorFocused || KeyboardController.isVisible();
    shouldRestoreAfterDismissRef.current = false;

    const openingId = openingIdRef.current + 1;
    openingIdRef.current = openingId;

    // Keyboard.dismiss() only tracks React Native TextInputs. The composer is
    // a custom native text view, so explicitly resign its first responder too.
    input.editorRef.current?.blur();
    // Rejection settles the presentation exactly like fulfillment: a failed
    // keyboard dismissal must not strand the phase in "opening" (dead
    // trigger) or escape as an unhandled rejection. The openingId guard
    // still keeps a stale attempt from reviving a closed presentation.
    const settle = () => {
      if (!isMountedRef.current || openingIdRef.current !== openingId) {
        return;
      }
      applyEvent("keyboard-dismissed");
    };
    KeyboardController.dismiss().then(settle, settle);
  }, [applyEvent, input.editorRef, input.isEditorFocused]);

  const close = useCallback(
    (reason: ThreadSettingsSheetCloseReason) => {
      if (applyEvent("close") === null) {
        return;
      }

      openingIdRef.current += 1;
      shouldRestoreAfterDismissRef.current = reason === "save" && restoreFocusOnSaveRef.current;
    },
    [applyEvent],
  );

  const onDismissed = useCallback(() => {
    if (applyEvent("dismissed") === null) {
      return;
    }

    // A dismissal can arrive while the keyboard-dismiss promise is still
    // pending (sheet unmounted mid-open); invalidate it so it can't flip the
    // phase back to visible after this reset.
    openingIdRef.current += 1;
    const shouldRestoreFocus = shouldRestoreAfterDismissRef.current;
    shouldRestoreAfterDismissRef.current = false;
    restoreFocusOnSaveRef.current = false;

    if (shouldRestoreFocus) {
      input.editorRef.current?.focus();
    }
  }, [applyEvent, input.editorRef]);

  // The new-task screen can have an autofocus queued before the sheet opens.
  // Preserve that intent for Save without allowing it to focus under the modal.
  const restoreFocusAfterSave = useCallback(() => {
    if (isActiveRef.current) {
      restoreFocusOnSaveRef.current = true;
    }
  }, []);

  return {
    isActive: phase !== "closed",
    isActiveRef,
    isVisible: phase === "visible",
    open,
    close,
    onDismissed,
    restoreFocusAfterSave,
  } as const;
}
