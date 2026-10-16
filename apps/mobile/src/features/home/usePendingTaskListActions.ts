import * as Dialog from "../../components/ui/Dialog";
import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";

import { removeThreadOutboxMessage } from "../../state/thread-outbox-removal";
import { clearComposerDraftContent } from "../../state/use-composer-drafts";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  editingQueuedMessageIdsAtom,
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
} from "../../state/use-thread-outbox";

export function usePendingTaskListActions(): {
  readonly openPendingTask: (pendingTask: PendingNewTask) => void;
  readonly confirmDeletePendingTask: (pendingTask: PendingNewTask) => void;
} {
  const navigation = useNavigation();

  const openPendingTask = useCallback(
    (pendingTask: PendingNewTask) => {
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(pendingTask.environmentId),
          projectId: String(pendingTask.projectId),
          ...(pendingTask.kind === "pending"
            ? { pendingTaskId: String(pendingTask.message.messageId) }
            : { draftId: pendingTask.draftKey }),
        },
      });
    },
    [navigation],
  );

  const confirmDeletePendingTask = useCallback((pendingTask: PendingNewTask) => {
    if (pendingTask.kind === "draft") {
      Dialog.alert("Discard draft?", `“${pendingTask.title}” will be removed.`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            clearComposerDraftContent(pendingTask.draftKey, {
              clearModelSelection: true,
              clearWorkspaceSelection: true,
            });
          },
        },
      ]);
      return;
    }
    // The drain must not deliver the task while the confirmation is open. An
    // open editor may already hold it; then that editor keeps owning the hold.
    const messageId = pendingTask.message.messageId;
    const heldForConfirmation = !appAtomRegistry.get(editingQueuedMessageIdsAtom)[messageId];
    if (heldForConfirmation) holdEditingQueuedMessage(messageId);
    let deleting = false;
    const releaseConfirmationHold = () => {
      if (heldForConfirmation && !deleting) releaseEditingQueuedMessage(messageId);
    };
    Dialog.alert(
      "Delete pending task?",
      `“${pendingTask.title}” has not been sent yet and will be removed from the outbox.`,
      [
        { text: "Cancel", style: "cancel", onPress: releaseConfirmationHold },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            deleting = true;
            // Release the edit lock only after removal succeeds, and only if
            // it is held for THIS task — clearing it up front (or for another
            // task) would let the drain deliver a mid-edit payload.
            void removeThreadOutboxMessage(pendingTask.message)
              .then(() => releaseEditingQueuedMessage(messageId))
              .catch((error) => {
                deleting = false;
                releaseConfirmationHold();
                Dialog.alert(
                  "Could not delete pending task",
                  error instanceof Error ? error.message : "The pending task could not be removed.",
                );
              });
          },
        },
      ],
      { cancelable: true, onDismiss: releaseConfirmationHold },
    );
  }, []);

  return { openPendingTask, confirmDeletePendingTask };
}
