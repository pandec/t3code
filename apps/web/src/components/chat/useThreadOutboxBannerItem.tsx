import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { SendIcon } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { readLocalApi } from "../../localApi";
import { removeThreadSubmission, useThreadOutboxStore } from "../../state/threadOutbox";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * Composer notice for this thread's messages the server has not accepted yet.
 * Discard is the way out for a message that should no longer send.
 */
export function useThreadOutboxBannerItem(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly environmentConnected: boolean;
  readonly onDiscarded: (messageIds: ReadonlyArray<MessageId>) => void;
}): ComposerBannerStackItem | null {
  const { environmentId, threadId, environmentConnected, onDiscarded } = input;
  const pending = useThreadOutboxStore(
    useShallow((state) =>
      state.submissions.filter(
        (submission) =>
          submission.environmentId === environmentId && submission.threadId === threadId,
      ),
    ),
  );
  const inFlight = useThreadOutboxStore((state) => state.inFlight);
  return useMemo(() => {
    if (pending.length === 0) return null;
    const discardable = pending.filter((submission) => !inFlight.has(submission.messageId));
    const count = pending.length;
    const discard = async () => {
      const label = discardable.length === 1 ? "this unsent message" : "these unsent messages";
      if ((await readLocalApi()?.dialogs.confirm(`Discard ${label}?`)) !== true) return;
      const removed: MessageId[] = [];
      for (const submission of discardable) {
        // A row a sender picked up meanwhile may already be with the server.
        if (useThreadOutboxStore.getState().inFlight.has(submission.messageId)) continue;
        removeThreadSubmission(submission.messageId);
        removed.push(submission.messageId);
      }
      if (removed.length > 0) onDiscarded(removed);
    };
    return {
      id: `thread-outbox:${environmentId}:${threadId}`,
      variant: "info",
      icon: <SendIcon />,
      title: `${count} ${count === 1 ? "message" : "messages"} waiting to send`,
      description: environmentConnected ? "Sending…" : "Sends when the server reconnects.",
      actions:
        discardable.length > 0 ? (
          <Button size="xs" variant="ghost" onClick={() => void discard()}>
            Discard
          </Button>
        ) : undefined,
    };
  }, [environmentConnected, environmentId, inFlight, onDiscarded, pending, threadId]);
}
