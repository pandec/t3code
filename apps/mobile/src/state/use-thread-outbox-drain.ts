import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { createThreadOutboxDelivery } from "@t3tools/client-runtime/state/thread-outbox-delivery";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type MessageId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { scopedThreadKey } from "../lib/scopedEntities";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { randomHex } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { useProjects, useThreadShells } from "./entities";
import { ensureThreadOutboxLoaded, removeThreadOutboxMessage } from "./thread-outbox";
import {
  isQueuedThreadCreationSendable,
  resolveThreadOutboxDeliveryAction,
  queuedThreadMessageIntent,
  selectNextQueuedThreadDispatch,
  threadOutboxRetryDelayMs,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import {
  editingQueuedMessageIdsAtom,
  useThreadOutboxMessages,
  useThreadOutboxShellStatuses,
} from "./use-thread-outbox";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
);

function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId);
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom);
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, current === queuedMessageId ? null : current);
}

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

function findCreationProject(
  projects: ReadonlyArray<EnvironmentProject>,
  message: QueuedThreadMessage,
): EnvironmentProject | undefined {
  return projects.find(
    (candidate) =>
      candidate.environmentId === message.environmentId &&
      candidate.id === message.creation?.projectId,
  );
}

export function useThreadOutboxDrain(): void {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const editingQueuedMessageIds = useAtomValue(editingQueuedMessageIdsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const shellStatuses = useThreadOutboxShellStatuses();
  const threads = useThreadShells();
  const projects = useProjects();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    ensureThreadOutboxLoaded();
    return () => {
      for (const timer of retryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      retryTimersRef.current.clear();
    };
  }, []);

  const delivery = useMemo(
    () =>
      createThreadOutboxDelivery({
        commands: {
          startTurn,
          updateMetadata: updateThreadMetadata,
          setRuntimeMode: setThreadRuntimeMode,
          setInteractionMode: setThreadInteractionMode,
        },
        removeQueuedMessage: removeThreadOutboxMessage,
        warn: (message, attributes) => {
          console.warn(message, attributes);
        },
      }),
    [setThreadInteractionMode, setThreadRuntimeMode, startTurn, updateThreadMetadata],
  );

  const sendQueuedCreation = useCallback(
    async (
      queuedMessage: QueuedThreadMessage,
      creation: QueuedThreadCreation,
      projectCwd: string,
    ) => {
      const modelSelection = queuedMessage.modelSelection;
      if (modelSelection === undefined) {
        return false;
      }
      const { completeDelivery } = delivery.makeDeliveryHelpers(queuedMessage);
      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: buildProjectThreadStartTurnInput({
          projectId: creation.projectId,
          projectCwd,
          threadId: queuedMessage.threadId,
          commandId: queuedMessage.commandId,
          messageId: queuedMessage.messageId,
          createdAt: queuedMessage.createdAt,
          text: queuedMessage.text.trim(),
          ...(queuedMessage.inputOrigin !== undefined
            ? { inputOrigin: queuedMessage.inputOrigin }
            : {}),
          attachments: queuedMessage.attachments,
          modelSelection,
          runtimeMode: queuedMessage.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: queuedMessage.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceMode: creation.workspaceMode,
          branch: creation.branch,
          worktreePath: creation.worktreePath,
          startFromOrigin: creation.startFromOrigin ?? false,
          worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
        }),
      });
      return completeDelivery(deliveryResult);
    },
    [delivery, startTurn],
  );

  useEffect(() => {
    if (dispatchingQueuedMessageId !== null) {
      return;
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const candidate = selectNextQueuedThreadDispatch(queuedMessages, {
        isHeld: (message) =>
          Boolean(editingQueuedMessageIds[message.messageId]) ||
          (retryNotBeforeRef.current.get(message.messageId) ?? 0) > Date.now(),
        resolveAction: (message) => {
          const thread = findThread(threads, message);
          if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
            return "wait";
          }
          const creation = message.creation;
          const environment = connectedEnvironments.find(
            (connected) => connected.environmentId === message.environmentId,
          );
          const shellStatus = shellStatuses.get(message.environmentId) ?? "empty";
          const action = resolveThreadOutboxDeliveryAction({
            isCreation: creation !== undefined,
            threadExists: thread !== undefined,
            shellStatus,
            environmentConnected: environment?.connectionState === "connected",
            threadStatus: thread?.session?.status ?? null,
            deliveryIntent: queuedThreadMessageIntent(message),
          });
          // An incomplete pending task (e.g. worktree mode without a branch)
          // stays queued until the user finishes it in the editor.
          if (action === "send" && creation !== undefined) {
            if (!isQueuedThreadCreationSendable(message)) {
              return "wait";
            }
            const creationProjectCwd =
              findCreationProject(projects, message)?.workspaceRoot ?? creation.projectCwd ?? null;
            if (creationProjectCwd === null && shellStatus !== "live") {
              return "wait";
            }
          }
          return action;
        },
      });
      if (candidate === null) {
        continue;
      }
      const nextQueuedMessage = candidate.message;
      const creation = nextQueuedMessage.creation;
      // The live project shell is preferred for the workspace path, with the
      // snapshot taken at enqueue time as the fallback so a task never dies
      // just because its project shell is not loaded.
      const creationProjectCwd =
        creation !== undefined
          ? (findCreationProject(projects, nextQueuedMessage)?.workspaceRoot ??
            creation.projectCwd ??
            null)
          : null;

      beginDispatchingQueuedMessage(nextQueuedMessage.messageId);
      const removeQueuedMessage = (warning: string) =>
        removeThreadOutboxMessage(nextQueuedMessage).then(
          () => true,
          (error) => {
            console.warn(warning, {
              environmentId: nextQueuedMessage.environmentId,
              threadId: nextQueuedMessage.threadId,
              messageId: nextQueuedMessage.messageId,
              error,
            });
            return false;
          },
        );
      const thread = findThread(threads, nextQueuedMessage);
      const dispatch =
        candidate.action === "remove"
          ? removeQueuedMessage("[thread-outbox] failed to remove message for a missing thread")
          : creation !== undefined
            ? creationProjectCwd !== null
              ? sendQueuedCreation(nextQueuedMessage, creation, creationProjectCwd)
              : removeQueuedMessage("[thread-outbox] dropped pending task for a missing project")
            : thread !== undefined
              ? delivery.sendQueuedMessage(nextQueuedMessage, thread)
              : Promise.resolve(false);
      void dispatch
        .then((sent) => {
          if (sent) {
            retryAttemptRef.current.delete(nextQueuedMessage.messageId);
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
            }
            return;
          }

          const retryAttempt = (retryAttemptRef.current.get(nextQueuedMessage.messageId) ?? 0) + 1;
          retryAttemptRef.current.set(nextQueuedMessage.messageId, retryAttempt);
          const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
          retryNotBeforeRef.current.set(nextQueuedMessage.messageId, Date.now() + retryDelayMs);
          const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
          if (pendingTimer !== undefined) {
            clearTimeout(pendingTimer);
          }
          const retryTimer = setTimeout(() => {
            retryTimersRef.current.delete(nextQueuedMessage.messageId);
            setRetryTick((current) => current + 1);
          }, retryDelayMs);
          retryTimersRef.current.set(nextQueuedMessage.messageId, retryTimer);
        })
        .finally(() => {
          finishDispatchingQueuedMessage(nextQueuedMessage.messageId);
        });
      return;
    }
  }, [
    connectedEnvironments,
    delivery,
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    projects,
    queuedMessagesByThreadKey,
    retryTick,
    sendQueuedCreation,
    shellStatuses,
    threads,
  ]);
}
