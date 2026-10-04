import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import {
  confirmThreadOutboxMessageQueued,
  threadOutboxRevision,
  type QueuedThreadMessage,
} from "./thread-outbox";
import { removeThreadOutboxMessage } from "./thread-outbox-removal";
import {
  flushComposerDrafts,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  undoComposerDraftMerge,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import {
  dispatchingQueuedMessageIdAtom,
  editingQueuedMessageIdsAtom,
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
} from "./use-thread-outbox";
import { stageThreadSettings, type ThreadSettings } from "./use-thread-staged-settings";

/**
 * Take delivery ownership before any await; the durable draft then takes ownership of the files.
 * The message's model and modes return as staged picks against `thread`, the thread's live
 * settings, so they hold only while the thread has not moved on.
 */
export async function editPendingThreadMessage(
  message: QueuedThreadMessage,
  thread: ThreadSettings | null,
): Promise<boolean> {
  if (
    message.creation ||
    appAtomRegistry.get(dispatchingQueuedMessageIdAtom) === message.messageId ||
    appAtomRegistry.get(editingQueuedMessageIdsAtom)[message.messageId]
  ) {
    return false;
  }
  holdEditingQueuedMessage(message.messageId);
  const draftKey = scopedThreadKey(message.environmentId, message.threadId);
  let rollback: {
    snapshot: ReturnType<typeof getComposerDraftSnapshot>;
    merged: ReturnType<typeof getComposerDraftSnapshot>;
  } | null = null;
  try {
    if (!(await confirmThreadOutboxMessageQueued(message))) return false;
    const revision = threadOutboxRevision(message.messageId);
    await waitForComposerDraftsLoaded();
    const snapshot = getComposerDraftSnapshot(draftKey);
    const attachmentIds = new Set(snapshot.attachments.map((attachment) => attachment.id));
    for (const attachment of message.attachments) attachmentIds.add(attachment.id);
    if (attachmentIds.size > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      throw new Error("Remove attachments from the composer before editing this message.");
    }
    try {
      await mergeComposerDraftContent(draftKey, message);
    } finally {
      rollback = { snapshot, merged: getComposerDraftSnapshot(draftKey) };
    }
    await flushComposerDrafts();
    if (!(await removeThreadOutboxMessage(message, revision))) return false;
    rollback = null;
    if (thread) {
      stageThreadSettings(
        draftKey,
        {
          ...(message.modelSelection ? { modelSelection: message.modelSelection } : {}),
          ...(message.runtimeMode ? { runtimeMode: message.runtimeMode } : {}),
          ...(message.interactionMode ? { interactionMode: message.interactionMode } : {}),
        },
        thread,
      );
    }
    return true;
  } finally {
    try {
      if (rollback) await undoComposerDraftMerge(draftKey, rollback.snapshot, rollback.merged);
    } finally {
      releaseEditingQueuedMessage(message.messageId);
    }
  }
}
