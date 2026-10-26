import * as Dialog from "../../components/ui/Dialog";
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
import { withThreadDismissal } from "./thread-dismissal";

export function usePendingTaskListActions(
  selectThreadRoute: (params: ReactNavigation.RootParamList["Thread"]) => void,
): {
  readonly openPendingTask: (pendingTask: PendingNewTask) => void;
  readonly confirmDeletePendingTask: (pendingTask: PendingNewTask) => void;
} {
  const openPendingTask = useCallback(
    (pendingTask: PendingNewTask) => {
      selectThreadRoute(
        pendingTask.kind === "pending"
          ? {
              environmentId: String(pendingTask.environmentId),
              threadId: String(pendingTask.message.threadId),
            }
          : {
              draft: {
                environmentId: String(pendingTask.environmentId),
                projectId: String(pendingTask.projectId),
                draftId: pendingTask.draftKey,
              },
            },
      );
    },
    [selectThreadRoute],
  );

  const confirmDeletePendingTask = useCallback((pendingTask: PendingNewTask) => {
    if (pendingTask.kind === "draft") {
      Dialog.alert("Discard draft?", `“${pendingTask.title}” will be removed.`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            void withThreadDismissal(
              pendingTask.key,
              async () =>
                clearComposerDraftContent(pendingTask.draftKey, {
                  clearModelSelection: true,
                  clearWorkspaceSelection: true,
                }),
              () => true,
            );
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
            // The row animates out before removal runs; the confirmation hold keeps a reconnect from
            // sending the task meanwhile. The editor can release the shared hold mid-animation, so an
            // edited task is removed at once and keeps its hold unless removal succeeds.
            const remove = () => removeThreadOutboxMessage(pendingTask.message);
            const restoreHold = () => {
              deleting = false;
              releaseConfirmationHold();
            };
            void (
              heldForConfirmation
                ? withThreadDismissal(pendingTask.key, remove, (removed) => removed)
                : remove()
            )
              .then((removed) => (removed ? releaseEditingQueuedMessage(messageId) : restoreHold()))
              .catch((error) => {
                restoreHold();
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
