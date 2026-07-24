import type { ScopedThreadRef } from "@t3tools/contracts";

export interface ArchiveUndoCandidate {
  readonly id: number;
  readonly threadRef: ScopedThreadRef;
  readonly threadTitle: string;
}

export interface ArchiveUndoHistory {
  arm: (input: Omit<ArchiveUndoCandidate, "id">) => ArchiveUndoCandidate;
  take: () => ArchiveUndoCandidate | null;
  restore: (candidate: ArchiveUndoCandidate) => void;
  discard: (threadRef: ScopedThreadRef) => void;
}

function isSameThread(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

export function createArchiveUndoHistory(): ArchiveUndoHistory {
  let nextId = 0;
  let candidate: ArchiveUndoCandidate | null = null;

  return {
    arm: (input) => {
      const nextCandidate = { ...input, id: ++nextId };
      candidate = nextCandidate;
      return nextCandidate;
    },
    take: () => {
      const taken = candidate;
      candidate = null;
      return taken;
    },
    restore: (restoredCandidate) => {
      // A newer archive always wins over a failed attempt to restore an older one.
      if (candidate === null) {
        candidate = restoredCandidate;
      }
    },
    discard: (threadRef) => {
      if (candidate && isSameThread(candidate.threadRef, threadRef)) {
        candidate = null;
      }
    },
  };
}

export const archiveUndoHistory = createArchiveUndoHistory();

export function isArchiveUndoShortcut(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
}): boolean {
  return (
    event.key.toLowerCase() === "z" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat
  );
}

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
].join(", ");

export function hasOpenArchiveUndoBlockingLayer(
  root: Pick<Document, "querySelector"> | null = typeof document === "undefined" ? null : document,
): boolean {
  return root !== null && root.querySelector(ARCHIVE_UNDO_BLOCKING_LAYER_SELECTOR) !== null;
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  const closest =
    target && typeof target === "object" && "closest" in target
      ? (target as { readonly closest?: unknown }).closest
      : null;
  if (typeof closest !== "function") {
    return false;
  }
  return (
    closest.call(
      target,
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    ) !== null
  );
}
