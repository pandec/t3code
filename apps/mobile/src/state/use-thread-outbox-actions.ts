import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { Alert } from "react-native";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { removeThreadOutboxMessage, updateThreadOutboxMessage } from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { getComposerDraftSnapshot, updateComposerDraftSettings } from "./use-composer-drafts";
import { appendContentToThreadDraft } from "./use-thread-composer-state";
import {
  editingQueuedMessageIdsAtom,
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
} from "./use-thread-outbox";
import { dispatchingQueuedMessageIdAtom } from "./use-thread-outbox-drain";

/**
 * Row actions for the queued-messages list. Pending-task creations are
 * excluded everywhere: they keep their NewTaskDraftScreen editing flow. A
 * message the drain is currently delivering is never touched — the delivery
 * already owns it.
 */
function isActionableQueuedMessage(message: QueuedThreadMessage): boolean {
  return (
    message.creation === undefined &&
    appAtomRegistry.get(dispatchingQueuedMessageIdAtom) !== message.messageId
  );
}

/** Marks a held message as a steer so the drain delivers it into the running turn. */
export async function steerQueuedMessageNow(message: QueuedThreadMessage): Promise<void> {
  if (
    !isActionableQueuedMessage(message) ||
    appAtomRegistry.get(editingQueuedMessageIdsAtom)[message.messageId]
  ) {
    return;
  }
  await updateThreadOutboxMessage({ ...message, deliveryIntent: "steer" });
}

export async function deleteQueuedMessage(message: QueuedThreadMessage): Promise<void> {
  if (!isActionableQueuedMessage(message)) {
    return;
  }
  await removeThreadOutboxMessage(message);
}

/**
 * Moves a queued message back into the thread's composer draft: content is
 * appended, settings carried over, and the queue entry removed. The edit hold
 * keeps the drain from delivering the message mid-move.
 */
export async function editQueuedMessage(message: QueuedThreadMessage): Promise<void> {
  if (!isActionableQueuedMessage(message)) {
    return;
  }
  const threadKey = scopedThreadKey(message.environmentId, message.threadId);
  const currentAttachmentCount = getComposerDraftSnapshot(threadKey).attachments.length;
  if (currentAttachmentCount + message.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    Alert.alert(
      `A message can contain up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images`,
      "Remove images from the composer before editing this queued message.",
    );
    return;
  }
  holdEditingQueuedMessage(message.messageId);
  try {
    // Remove first: if this fails the message simply stays queued, whereas
    // appending first could leave the content both queued and in the draft.
    const removed = await removeThreadOutboxMessage(message);
    if (!removed) return;
    appendContentToThreadDraft({
      environmentId: message.environmentId,
      threadId: message.threadId,
      text: message.text,
      attachments: message.attachments,
    });
    updateComposerDraftSettings(threadKey, {
      ...(message.modelSelection !== undefined ? { modelSelection: message.modelSelection } : {}),
      ...(message.runtimeMode !== undefined ? { runtimeMode: message.runtimeMode } : {}),
      ...(message.interactionMode !== undefined
        ? { interactionMode: message.interactionMode }
        : {}),
    });
  } finally {
    releaseEditingQueuedMessage(message.messageId);
  }
}
