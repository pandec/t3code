import type { ModelOption } from "../../lib/modelOptions";

export type SheetPresentationPhase = "closed" | "opening" | "visible" | "closing";

export type SheetPresentationEvent =
  /** The trigger pill was pressed. */
  | "open"
  /** The keyboard finished dismissing, so the modal may become visible. */
  | "keyboard-dismissed"
  /** Save/Done or a dismiss gesture asked the modal to leave. */
  | "close"
  /** The modal finished leaving (onDismiss, Android visibility, or unmount). */
  | "dismissed";

/**
 * Pure phase table for the settings-sheet presentation; `null` means the
 * event is ignored in that phase. "dismissed" must be accepted from every
 * non-closed phase and ignored when already closed: Modal.onDismiss, the
 * Android visibility effect, and the sheet's unmount cleanup (the new-task
 * screen unmounts a presented sheet when its project disappears) can all
 * fire for the same presentation, and a dropped or duplicated notification
 * would otherwise deadlock the trigger.
 */
export function sheetPresentationPhaseAfterEvent(
  phase: SheetPresentationPhase,
  event: SheetPresentationEvent,
): SheetPresentationPhase | null {
  switch (event) {
    case "open":
      return phase === "closed" ? "opening" : null;
    case "keyboard-dismissed":
      return phase === "opening" ? "visible" : null;
    case "close":
      return phase === "opening" || phase === "visible" ? "closing" : null;
    case "dismissed":
      return phase === "closed" ? null : "closed";
  }
}

/** Preserve staged provider options when the highlighted model is tapped again. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  return input.current?.key === input.pressed.key ? input.current : input.pressed;
}
