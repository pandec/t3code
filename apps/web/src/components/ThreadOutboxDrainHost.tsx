import { threadSubmissionRetryDelayMs } from "@t3tools/client-runtime/state/thread-submission-outbox";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type MessageId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { useConnectedEnvironmentIds } from "../state/environments";
import {
  claimThreadSubmission,
  releaseThreadSubmission,
  removeThreadSubmission,
  resolveThreadSubmissionOutcome,
  selectThreadSubmissionsToSend,
  threadSubmissionFailure,
  useThreadOutboxStore,
  type PendingThreadSubmission,
} from "../state/threadOutbox";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "./ui/toast";

/**
 * Sends the web outbox's unaccepted messages whenever their environment is
 * connected, including after a reload. Mounted once at the app root.
 */
export function ThreadOutboxDrainHost() {
  const submissions = useThreadOutboxStore((state) => state.submissions);
  const inFlight = useThreadOutboxStore((state) => state.inFlight);
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const connected = useMemo(() => new Set(connectedEnvironmentIds), [connectedEnvironmentIds]);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const setRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const attemptsRef = useRef(new Map<MessageId, number>());
  const retryAtRef = useRef(new Map<MessageId, number>());
  // Advanced by backoff timers so rows whose retry time has passed are picked up.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const previousConnectedRef = useRef(connected);

  // A reconnect retries at once instead of waiting out a backoff from before it.
  useEffect(() => {
    if (previousConnectedRef.current === connected) return;
    previousConnectedRef.current = connected;
    retryAtRef.current.clear();
  }, [connected]);

  const deliver = useEffectEvent(async (submission: PendingThreadSubmission) => {
    if (!claimThreadSubmission(submission.messageId)) return;
    const commandIdFor = (suffix: string) => CommandId.make(`${submission.commandId}:${suffix}`);
    let failure: ReturnType<typeof threadSubmissionFailure> = null;
    if (submission.settings !== undefined) {
      failure = threadSubmissionFailure(
        await setRuntimeMode({
          environmentId: submission.environmentId,
          input: {
            threadId: submission.threadId,
            commandId: commandIdFor("runtime-mode"),
            runtimeMode: submission.settings.runtimeMode,
          },
        }),
      );
      failure ??= threadSubmissionFailure(
        await setInteractionMode({
          environmentId: submission.environmentId,
          input: {
            threadId: submission.threadId,
            commandId: commandIdFor("interaction-mode"),
            interactionMode: submission.settings.interactionMode,
          },
        }),
      );
    }
    failure ??= threadSubmissionFailure(
      await startTurn({
        environmentId: submission.environmentId,
        input: {
          threadId: submission.threadId,
          commandId: submission.commandId,
          message: {
            messageId: submission.messageId,
            role: "user",
            text: submission.text,
            attachments: submission.attachments,
            ...(submission.context === undefined ? {} : { context: submission.context }),
          },
          ...(submission.modelSelection === undefined
            ? {}
            : { modelSelection: submission.modelSelection }),
          ...(submission.titleSeed === undefined ? {} : { titleSeed: submission.titleSeed }),
          // Only thread launches read these; an existing thread's settings were applied above.
          runtimeMode: submission.settings?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode:
            submission.settings?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          dispatchMode: submission.dispatchMode,
          createdAt: submission.createdAt,
        },
      }),
    );
    const outcome = resolveThreadSubmissionOutcome(failure);
    if (outcome === "retry") {
      const attempt = (attemptsRef.current.get(submission.messageId) ?? 0) + 1;
      attemptsRef.current.set(submission.messageId, attempt);
      const delayMs = threadSubmissionRetryDelayMs(attempt);
      retryAtRef.current.set(submission.messageId, Date.now() + delayMs);
      releaseThreadSubmission(submission.messageId);
      window.setTimeout(() => setNowMs(Date.now()), delayMs);
      return;
    }
    attemptsRef.current.delete(submission.messageId);
    retryAtRef.current.delete(submission.messageId);
    removeThreadSubmission(submission.messageId);
    if (outcome === "rejected") {
      const error = failure?.error;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "A pending message could not be sent",
          description: `${error instanceof Error ? error.message : "The server rejected it."}\n\n${submission.text}`,
          timeout: 0,
        }),
      );
    }
  });

  useEffect(() => {
    for (const submission of selectThreadSubmissionsToSend({
      submissions,
      inFlight,
      connectedEnvironmentIds: connected,
      retryAtByMessageId: retryAtRef.current,
      nowMs,
    })) {
      void deliver(submission);
    }
  }, [connected, inFlight, nowMs, submissions]);

  return null;
}
