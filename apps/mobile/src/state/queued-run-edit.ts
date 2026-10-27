import type {
  ChatAttachment,
  MessageId,
  MessageInputOrigin,
  OrchestrationMessageContext,
  RunId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  makeQueuedRunEditStore,
  type QueuedRunsAtom,
} from "@t3tools/client-runtime/queued-run-edit";

import { uploadedComposerContext } from "../lib/composerContext";
import { downloadServerAttachmentToDraft } from "../lib/composerContextClipboard";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { abortComposerDraftOperations } from "./composerDraftOperations";
import { queuedEditDraftKey } from "./queued-edit-draft-key";
import { setThreadComposerError } from "./thread-composer-error";
import { environmentThreadDetails, environmentThreadShells } from "./threads";
import {
  appendComposerDraftAttachments,
  clearComposerDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  setComposerContextImporting,
  setComposerDraftContext,
  setComposerDraftText,
} from "./use-composer-drafts";
import { stageThreadSettings } from "./use-thread-staged-settings";

export interface QueuedRunEdit {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
  readonly inputOrigin?: MessageInputOrigin;
  /** Removing a server attachment changes the message even when the draft looks untouched. */
  readonly removedExistingAttachment?: true;
}

const queuedRunEdits = makeQueuedRunEditStore<QueuedRunEdit>({
  registry: appAtomRegistry,
  label: "mobile-queued-run-edits",
});

export const queuedRunEditsAtom = queuedRunEdits.atom;

export { isQueuedEditDraftKey, queuedEditDraftKey } from "./queued-edit-draft-key";

export const getQueuedRunEdit = queuedRunEdits.get;

/**
 * The draft a sheet opened for `requestedKey` should edit now: a queued edit's
 * draft only while that edit is still open, else the thread's own draft.
 */
export function activeComposerDraftKey(
  threadKey: string,
  requestedKey: string,
  edit: QueuedRunEdit | null,
): string {
  if (requestedKey === threadKey) return threadKey;
  return edit !== null && queuedEditDraftKey(threadKey, edit.runId) === requestedKey
    ? requestedKey
    : threadKey;
}

export function useQueuedRunEdit(threadKey: string | null): QueuedRunEdit | null {
  const edits = useAtomValue(queuedRunEdits.atom);
  return threadKey === null ? null : (edits[threadKey] ?? null);
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

/**
 * Fork: a changed edit is appended to the thread's draft even when that draft
 * has other work, with its saved attachments downloaded back, its context and
 * input origin kept, and its run's model staged on the thread.
 */
function restoreQueuedRunEdit(
  threadKey: string,
  edit: QueuedRunEdit,
  editDraft: ReturnType<typeof getComposerDraftSnapshot>,
): void {
  const ref = parseScopedThreadKey(threadKey);
  // Saved attachments get their draft ids up front so the edit's chips bind to
  // the copies; a failed download takes its chip with it.
  const saved = ref === null ? [] : edit.existingAttachments;
  const savedLocalIds = new Map(saved.map((attachment) => [attachment.id, uuidv4()] as const));
  const context = rebindQueuedEditContext(editDraft.context, savedLocalIds);
  const report = (failedCount: number) => {
    const overLimit =
      getComposerDraftSnapshot(threadKey).attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
    setThreadComposerError(
      threadKey,
      [
        failedCount === 0
          ? "That message is no longer queued. Your edit is back in the composer."
          : `That message is no longer queued. Your edit is back in the composer without ${failedCount} saved attachment${failedCount === 1 ? "" : "s"} that could not be downloaded.`,
        ...(overLimit
          ? [
              `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} before sending.`,
            ]
          : []),
      ].join(" "),
    );
  };
  // Attachments may go past the per-message limit here (sending still enforces it) so a rescue never drops one.
  const restoreAttachments = async () => {
    appendComposerDraftAttachments(threadKey, editDraft.attachments, { allowOverflow: true });
    if (ref === null || saved.length === 0) return 0;
    const signal = new AbortController().signal;
    const results = await Promise.allSettled(
      saved.map((attachment) =>
        downloadServerAttachmentToDraft(
          {
            attachmentId: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            kind: attachment.type === "image" ? "image" : "file",
          },
          ref.environmentId,
          signal,
          savedLocalIds.get(attachment.id),
        ),
      ),
    );
    const downloaded = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    appendComposerDraftAttachments(threadKey, downloaded, { allowOverflow: true });
    saved.forEach((attachment, index) => {
      const localId = savedLocalIds.get(attachment.id);
      if (results[index]?.status === "rejected" && localId !== undefined) {
        removeComposerDraftAttachment(threadKey, localId);
      }
    });
    return saved.length - downloaded.length;
  };
  // The import flag holds sending until the downloads land, so they cannot leak into the next draft.
  const restoring = saved.length > 0;
  if (restoring) setComposerContextImporting(threadKey, true);
  void mergeComposerDraftContent(threadKey, {
    text: editDraft.text,
    attachments: [],
    ...(context ? { context } : {}),
    ...(editDraft.inputOrigin ? { inputOrigin: editDraft.inputOrigin } : {}),
  })
    .then(restoreAttachments, restoreAttachments)
    .then(report, () => report(saved.length))
    .finally(() => {
      if (restoring) setComposerContextImporting(threadKey, false);
    });
  if (ref === null) return;
  const thread = appAtomRegistry.get(environmentThreadShells.quietThreadShellAtom(ref));
  const run = appAtomRegistry
    .get(environmentThreadDetails.quietThreadAtom(ref))
    ?.projection.runs.find((candidate) => candidate.id === edit.runId);
  if (thread !== null && run !== undefined) {
    stageThreadSettings(threadKey, { modelSelection: run.modelSelection }, thread);
  }
}

/**
 * The run started or was cancelled elsewhere, wherever the user is when it
 * happens. A changed edit goes back into the thread's composer; one cleared
 * to nothing is dropped.
 */
function exitQueuedRunEdit(threadKey: string, edit: QueuedRunEdit): void {
  const editDraftKey = queuedEditDraftKey(threadKey, edit.runId);
  const editDraft = getComposerDraftSnapshot(editDraftKey);
  const changed =
    editDraft.text !== edit.originalText ||
    editDraft.attachments.length > 0 ||
    edit.removedExistingAttachment === true;
  const restorable =
    changed &&
    (editDraft.text.trim().length > 0 ||
      editDraft.attachments.length > 0 ||
      edit.existingAttachments.length > 0);
  if (restorable) restoreQueuedRunEdit(threadKey, edit, editDraft);
  clearComposerDraft(editDraftKey, { deferAttachmentCleanup: restorable });
  if (changed && !restorable) {
    setThreadComposerError(
      threadKey,
      "That message is no longer queued, so the edit was discarded.",
    );
  }
}

/** `runs` is the thread's runs; the edit ends when its run leaves the queue. */
export function beginQueuedRunEdit(
  threadKey: string,
  edit: QueuedRunEdit,
  runs: QueuedRunsAtom,
): void {
  const previous = getQueuedRunEdit(threadKey);
  if (previous !== null && previous.runId !== edit.runId) {
    clearComposerDraft(queuedEditDraftKey(threadKey, previous.runId));
  }
  // The composer moves off the thread draft, so a paste or pick still running for it is dropped.
  abortComposerDraftOperations(threadKey);
  const draftKey = queuedEditDraftKey(threadKey, edit.runId);
  clearComposerDraft(draftKey);
  setComposerDraftText(draftKey, edit.originalText, edit.inputOrigin);
  setComposerDraftContext(draftKey, edit.context);
  queuedRunEdits.begin(threadKey, edit, { runs, onRunLeftQueue: exitQueuedRunEdit });
}

export function removeQueuedRunEditAttachment(threadKey: string, attachmentId: string): void {
  queuedRunEdits.update(threadKey, (edit) => ({
    ...edit,
    removedExistingAttachment: true,
    existingAttachments: edit.existingAttachments.filter(
      (attachment) => attachment.id !== attachmentId,
    ),
  }));
}

export function endQueuedRunEdit(
  threadKey: string,
  options?: { readonly deferAttachmentCleanup?: boolean },
): void {
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null) return;
  clearComposerDraft(queuedEditDraftKey(threadKey, edit.runId), options);
  queuedRunEdits.end(threadKey);
}

/**
 * Claims the open edit for a save; while it runs, the save's result decides the
 * edit's fate. Null when there is no edit or a save is already in flight.
 */
export const startQueuedRunEditSave = queuedRunEdits.startSave;

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
