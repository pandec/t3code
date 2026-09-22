import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { useRouter } from "@tanstack/react-router";

import { composerDraftHasUserContent, useComposerDraftStore } from "./composerDraftStore";
import { draftSubmissionTracker } from "./draftSubmissionState";
import { readThreadShell } from "./state/entities";
import { resolveThreadRouteTarget } from "./threadRoutes";

export function resolveEmptyDraftIdForArchiveUndo(
  routeTarget:
    | { readonly kind: "draft"; readonly draftId: string }
    | { readonly kind: "server" }
    | null,
  hasDraftContent: boolean,
  hasMaterializedThread: boolean,
): string | null {
  return routeTarget?.kind === "draft" && !hasDraftContent && !hasMaterializedThread
    ? routeTarget.draftId
    : null;
}

/** The draft the current route shows, if it is still empty and never submitted.
 *  Undoing an archive may replace such a draft with the restored thread; a
 *  draft the reader typed into or sent stays in view instead. */
export function readEmptyNewThreadDraftId(router: ReturnType<typeof useRouter>): string | null {
  const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
  const target = resolveThreadRouteTarget(params);
  if (target?.kind !== "draft") {
    return null;
  }
  const composerState = useComposerDraftStore.getState();
  const draftSession = composerState.getDraftSession(target.draftId);
  const hasObservedThread = Boolean(
    draftSession &&
    (draftSession.promotedTo ||
      readThreadShell(scopeThreadRef(draftSession.environmentId, draftSession.threadId))),
  );
  const hasStartedSubmission = draftSubmissionTracker.hasStarted(target.draftId);
  if (hasObservedThread) {
    draftSubmissionTracker.clear(target.draftId);
  }
  return resolveEmptyDraftIdForArchiveUndo(
    target,
    composerDraftHasUserContent(composerState.getComposerDraft(target.draftId)),
    hasObservedThread || hasStartedSubmission,
  );
}

const ARCHIVE_UNDO_BLOCKING_LAYER_SELECTOR = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="sheet-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
  '[data-slot="command-dialog-popup"]',
  "[data-model-picker-content]",
  '[aria-modal="true"]',
].join(", ");

/** Thread archive and undo shortcuts stay inert while a floating layer owns
 *  the interaction, so a chord meant for a dialog never flips a thread. */
export function hasOpenArchiveUndoBlockingLayer(
  root: Pick<Document, "querySelector"> | null = typeof document === "undefined" ? null : document,
): boolean {
  return root !== null && root.querySelector(ARCHIVE_UNDO_BLOCKING_LAYER_SELECTOR) !== null;
}
