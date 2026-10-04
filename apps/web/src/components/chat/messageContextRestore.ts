import type {
  ComposerContextRecord,
  EnvironmentId,
  PreviewAnnotationPayload,
  ThreadContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import {
  asKnownContextRecord,
  previewAnnotationContextId,
  previewAnnotationFromRecord,
  reviewCommentContextId,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
  terminalContextReference,
} from "../../lib/composerContextRecords";
import {
  formatInlineContextReference,
  toKindScopedComposerContextId,
  type ComposerContextReference,
} from "../../lib/composerContextReferences";
import { elementContextToPreviewAnnotation } from "../../lib/elementContext";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { randomUUID } from "~/lib/utils";

export interface MessageContextRestore {
  /** The message text with every chip pointing at its restored draft context. */
  readonly text: string;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}

/**
 * Rebuilds the draft context behind a sent message's chips, so its text can go
 * back into a composer (rewind, a rescued queued edit) with working chips.
 * Only records the text references are restored. Image and file chips bind to
 * the restored draft attachments through `attachmentLocalIds` (server
 * attachment id to draft attachment id). A chip whose record cannot be rebuilt
 * here (a removed attachment, another server's thread, a kind this composer
 * has no draft shape for) keeps its label as plain text. References without a
 * record are left alone unless `labelUnmatchedReferences` is set.
 */
export function planMessageContextRestore(input: {
  readonly text: string;
  readonly records: ReadonlyArray<ComposerContextRecord>;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly attachmentLocalIds: ReadonlyMap<string, string>;
  /** Terminal excerpts already in the destination; a matching record reuses them. */
  readonly existingTerminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly labelUnmatchedReferences?: boolean;
  readonly makeId?: () => string;
}): MessageContextRestore {
  const makeId = input.makeId ?? randomUUID;
  const recordsById = new Map<string, ComposerContextRecord>(
    input.records.map((record) => [record.contextId, record]),
  );
  const terminalContexts: TerminalContextDraft[] = [];
  const reviewComments: ReviewCommentContext[] = [];
  const previewAnnotations: PreviewAnnotationPayload[] = [];
  const threadContexts: ThreadContextRecord[] = [];
  // null: the record exists but has no draft shape here, so the chip becomes its label.
  const restored = new Map<string, Omit<ComposerContextReference, "label"> | null>();
  const restore = (contextId: string): Omit<ComposerContextReference, "label"> | null => {
    const record = asKnownContextRecord(recordsById.get(contextId));
    switch (record?.kind) {
      case "terminal": {
        const existing = input.existingTerminalContexts.find(
          (context) =>
            context.terminalId === record.terminalId &&
            context.lineStart === record.lineStart &&
            context.lineEnd === record.lineEnd,
        );
        const draft = existing ?? {
          ...terminalContextDraftFromRecord(record, input.threadId),
          id: makeId(),
        };
        if (existing === undefined) terminalContexts.push(draft);
        return terminalContextReference(draft);
      }
      case "review-comment": {
        const comment = { ...reviewCommentFromRecord(record), id: makeId() };
        reviewComments.push(comment);
        return { kind: "review-comment", contextId: reviewCommentContextId(comment.id) };
      }
      case "element":
      case "preview-annotation": {
        // A screenshot attachment reuses its annotation's id, which keeps the two linked on send.
        const screenshot =
          record.kind === "preview-annotation" && record.screenshotContextId !== undefined
            ? recordsById.get(record.screenshotContextId)
            : undefined;
        const screenshotLocalId =
          screenshot !== undefined && "attachmentId" in screenshot
            ? input.attachmentLocalIds.get(screenshot.attachmentId)
            : undefined;
        const id = screenshotLocalId ?? makeId();
        const annotation =
          record.kind === "element"
            ? elementContextToPreviewAnnotation(record, id, new Date().toISOString())
            : { ...previewAnnotationFromRecord(record), id };
        previewAnnotations.push(annotation);
        return { kind: "preview-annotation", contextId: previewAnnotationContextId(id) };
      }
      case "thread": {
        // The agent can only read threads on its own server.
        if (record.environmentId !== input.environmentId) return null;
        threadContexts.push(record);
        return { kind: "thread", contextId: record.contextId };
      }
      case "image":
      case "file": {
        const localId = input.attachmentLocalIds.get(record.attachmentId);
        return localId === undefined
          ? null
          : { kind: record.kind, contextId: toKindScopedComposerContextId(record.kind, localId) };
      }
      default:
        return null;
    }
  };
  const text = replaceComposerContextReferences(input.text, (occurrence) => {
    if (!recordsById.has(occurrence.contextId)) {
      return input.labelUnmatchedReferences === true ? occurrence.label : occurrence.source;
    }
    if (!restored.has(occurrence.contextId)) {
      restored.set(occurrence.contextId, restore(occurrence.contextId));
    }
    const reference = restored.get(occurrence.contextId);
    return reference
      ? formatInlineContextReference({ ...reference, label: occurrence.label })
      : occurrence.label;
  });
  return { text, terminalContexts, reviewComments, previewAnnotations, threadContexts };
}

/** Adds a planned restore's contexts to a draft whose prompt already holds their chips. */
export function applyMessageContextRestore(
  target: ComposerThreadTarget,
  restore: MessageContextRestore,
): void {
  const store = useComposerDraftStore.getState();
  const options = { appendReference: false };
  if (restore.terminalContexts.length > 0) {
    store.addTerminalContexts(target, [...restore.terminalContexts], options);
  }
  for (const comment of restore.reviewComments) store.addReviewComment(target, comment, options);
  for (const annotation of restore.previewAnnotations) {
    store.addPreviewAnnotation(target, annotation, options);
  }
  if (restore.threadContexts.length > 0) {
    store.addThreadContexts(target, restore.threadContexts, options);
  }
}
