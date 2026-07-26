import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { Alert } from "react-native";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { removeThreadOutboxMessage, updateThreadOutboxMessage } from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import {
  appendComposerDraftContentDurably,
  appendedComposerDraftText,
  getComposerDraftSnapshot,
  revertComposerDraftAppend,
  updateComposerDraftSettings,
} from "./use-composer-drafts";
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
 * appended, verified, and only then the queue entry removed, so a failed move
 * leaves the message queued rather than destroying it. The edit hold keeps the
 * drain from delivering the message mid-move.
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
  if (!holdEditingQueuedMessage(message.messageId)) {
    return;
  }
  // Set before the first await: once the queued row is gone the draft holds the
  // only copy, so a later failure must never revert it away.
  let removed = false;
  let revertAppend: (() => boolean) | null = null;
  try {
    // Append to the draft FIRST, then drop the queued row. Removal is durable
    // (the row leaves persisted storage too), so removing first would destroy
    // the message outright whenever the append does not land.
    const append = await appendComposerDraftContentDurably(threadKey, {
      text: message.text,
      attachments: message.attachments,
    });
    revertAppend = () => revertComposerDraftAppend(threadKey, append);

    // Confirm the content really is in the draft before the queued copy is
    // destroyed. The append is acknowledged only after the destination file
    // contains this exact snapshot.
    const appendedAttachmentIds = new Set(append.appended.attachments.map(({ id }) => id));
    const contentAppended =
      append.status === "committed" &&
      append.appended.text === appendedComposerDraftText(append.before.text, message.text) &&
      message.attachments.every(({ id }) => appendedAttachmentIds.has(id));
    if (!contentAppended) {
      const fullyReverted = revertAppend();
      Alert.alert(
        "Could not open this message for editing",
        fullyReverted
          ? "It is still queued — try again, or delete it if you no longer need it."
          : "It is still queued, and newer composer changes were kept. Review the composer before sending to avoid a duplicate.",
      );
      return;
    }

    removed = await removeThreadOutboxMessage(message);
    if (!removed) {
      // The atomic edit hold rules out a second local edit. Another action
      // already removed the queued row, so the durable composer copy is the
      // only copy this handler still owns and must not be reverted.
      return;
    }

    updateComposerDraftSettings(threadKey, {
      ...(message.modelSelection !== undefined ? { modelSelection: message.modelSelection } : {}),
      ...(message.runtimeMode !== undefined ? { runtimeMode: message.runtimeMode } : {}),
      ...(message.interactionMode !== undefined
        ? { interactionMode: message.interactionMode }
        : {}),
    });
  } catch (error) {
    if (removed) {
      // The queued row is already gone, so the draft holds the only copy of the
      // message — reverting here would destroy it.
      console.warn("[thread-outbox] queued message appended but its setup failed", error);
    } else {
      const fullyReverted = revertAppend?.() ?? true;
      Alert.alert(
        "Could not open this message for editing",
        fullyReverted
          ? "It is still queued — try again, or delete it if you no longer need it."
          : "It is still queued, and newer composer changes were kept. Review the composer before sending to avoid a duplicate.",
      );
    }
  } finally {
    releaseEditingQueuedMessage(message.messageId);
  }
}
