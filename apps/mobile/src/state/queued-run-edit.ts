import type {
  ChatAttachment,
  MessageId,
  MessageInputOrigin,
  OrchestrationMessageContext,
  RunId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { uploadedComposerContext } from "../lib/composerContext";
import { appAtomRegistry } from "./atom-registry";
import { queuedEditDraftKey } from "./queued-edit-draft-key";
import {
  clearComposerDraft,
  setComposerDraftContext,
  setComposerDraftText,
} from "./use-composer-drafts";

export interface QueuedRunEdit {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
  readonly inputOrigin?: MessageInputOrigin;
  /** How many attachments the message had when the edit began (set on begin). */
  readonly originalAttachmentCount?: number;
}

export const queuedRunEditsAtom = Atom.make<Readonly<Record<string, QueuedRunEdit>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-queued-run-edits"),
);

export { isQueuedEditDraftKey, queuedEditDraftKey } from "./queued-edit-draft-key";

export function getQueuedRunEdit(threadKey: string | null): QueuedRunEdit | null {
  if (threadKey === null) return null;
  return appAtomRegistry.get(queuedRunEditsAtom)[threadKey] ?? null;
}

export function useQueuedRunEdit(threadKey: string | null): QueuedRunEdit | null {
  const edits = useAtomValue(queuedRunEditsAtom);
  return threadKey === null ? null : (edits[threadKey] ?? null);
}

function setQueuedRunEdit(threadKey: string, edit: QueuedRunEdit | null): void {
  const current = appAtomRegistry.get(queuedRunEditsAtom);
  if (edit === null) {
    if (!current[threadKey]) return;
    const next = { ...current };
    delete next[threadKey];
    appAtomRegistry.set(queuedRunEditsAtom, next);
    return;
  }
  appAtomRegistry.set(queuedRunEditsAtom, { ...current, [threadKey]: edit });
}

export function beginQueuedRunEdit(threadKey: string, edit: QueuedRunEdit): void {
  const previous = getQueuedRunEdit(threadKey);
  if (previous !== null && previous.runId !== edit.runId) {
    clearComposerDraft(queuedEditDraftKey(threadKey, previous.runId));
  }
  const draftKey = queuedEditDraftKey(threadKey, edit.runId);
  clearComposerDraft(draftKey);
  setComposerDraftText(draftKey, edit.originalText, edit.inputOrigin);
  setComposerDraftContext(draftKey, edit.context);
  setQueuedRunEdit(threadKey, {
    ...edit,
    originalAttachmentCount: edit.existingAttachments.length,
  });
}

/**
 * Whether an edit holds unsaved changes worth rescuing into the thread's draft
 * when its run leaves the queue: new text, new attachments, or a removed
 * saved attachment. An untouched edit is simply closed.
 */
export function queuedRunEditHasChanges(
  edit: QueuedRunEdit,
  draft: { readonly text: string; readonly attachments: ReadonlyArray<unknown> },
): boolean {
  return (
    draft.text !== edit.originalText ||
    draft.attachments.length > 0 ||
    edit.existingAttachments.length < (edit.originalAttachmentCount ?? 0)
  );
}

/**
 * The edit's context with records for saved attachments rebound to the draft
 * ids their downloaded copies take when a rescue brings them back.
 */
export function rebindQueuedEditContext(
  context: OrchestrationMessageContext | undefined,
  localIds: ReadonlyMap<string, string>,
): OrchestrationMessageContext | undefined {
  if (context === undefined || localIds.size === 0) return context;
  return {
    ...context,
    records: context.records.map((record) => {
      const localId = "attachmentId" in record ? localIds.get(record.attachmentId) : undefined;
      return localId === undefined ? record : { ...record, attachmentId: localId };
    }),
  };
}

export function removeQueuedRunEditAttachment(threadKey: string, attachmentId: string): void {
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null) return;
  setQueuedRunEdit(threadKey, {
    ...edit,
    existingAttachments: edit.existingAttachments.filter(
      (attachment) => attachment.id !== attachmentId,
    ),
  });
}

export function endQueuedRunEdit(
  threadKey: string,
  options?: { readonly deferAttachmentCleanup?: boolean },
): void {
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null) return;
  clearComposerDraft(queuedEditDraftKey(threadKey, edit.runId), options);
  setQueuedRunEdit(threadKey, null);
}

/** Attachments replace wholesale; resend kept server attachments with uploads in composer order. */
export function resolveQueuedEditPayload(input: {
  readonly edit: QueuedRunEdit;
  readonly draftContext: OrchestrationMessageContext | undefined;
  readonly draftAttachments: ReadonlyArray<{ readonly id: string }>;
  readonly uploaded: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
}): {
  readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
  readonly context: OrchestrationMessageContext | undefined;
} {
  const attachments = [...input.edit.existingAttachments, ...input.uploaded];
  const rebound = uploadedComposerContext(
    input.draftContext,
    input.draftAttachments,
    input.uploaded,
  );
  if (rebound === undefined) return { attachments, context: undefined };
  const liveIds = new Set(
    attachments.flatMap((attachment) =>
      "id" in attachment && attachment.id ? [attachment.id] : [],
    ),
  );
  const records = rebound.records.filter(
    (record) => !("attachmentId" in record) || liveIds.has(record.attachmentId),
  );
  return {
    attachments,
    context: records.length > 0 ? { version: 1, records } : undefined,
  };
}
