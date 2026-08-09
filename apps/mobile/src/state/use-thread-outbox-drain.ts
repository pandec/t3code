import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { createThreadOutboxDelivery } from "@t3tools/client-runtime/state/thread-outbox-delivery";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type MessageId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { scopedThreadKey } from "../lib/scopedEntities";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { randomHex } from "../lib/uuid";
import { refreshArchivedThreadsForEnvironment } from "../features/archive/useArchivedThreadSnapshots";
import { appAtomRegistry } from "./atom-registry";
import { useProjects, useThreadShells } from "./entities";
import {
  confirmThreadOutboxMessageQueued,
  ensureThreadOutboxLoaded,
  isThreadOutboxMessageWaitingForPreferences,
  removeThreadOutboxMessage,
} from "./thread-outbox";
import {
  flattenQueuedThreadMessages,
  isQueuedThreadCreationSendable,
  isSteerWaitingOutGraceWindow,
  pruneExpeditedQueuedMessageIds,
  queueFlushBatchIds,
  queuedThreadMessageIntent,
  resolveThreadOutboxDeliveryAction,
  selectNextQueuedThreadDispatch,
  soonestSteerGraceRemainingMs,
  threadOutboxRetryDelayMs,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import {
  environmentThreadShells,
  environmentThreads,
  threadDetailToShell,
  threadEnvironment,
} from "./threads";
import { noteThreadSteerDispatch } from "./thread-steer-pending";
import { useAtomCommand } from "./use-atom-command";
import { useMobilePreferencesHydrated, useSteerGraceWindowMs } from "./use-mobile-preferences";
import {
  editingQueuedMessageIdsAtom,
  expeditedQueuedMessageIdsAtom,
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

function findThreadIncludingLoadedDetail(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  const shell = findThread(threads, message);
  if (shell !== undefined) {
    return shell;
  }
  const state = Option.getOrUndefined(
    AsyncResult.value(
      appAtomRegistry.get(environmentThreads.stateAtom(message.environmentId, message.threadId)),
    ),
  );
  const detail = state === undefined ? undefined : Option.getOrUndefined(state.data);
  return detail === undefined ? undefined : threadDetailToShell(message.environmentId, detail);
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
  const expeditedMessageIds = useAtomValue(expeditedQueuedMessageIdsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  // Read live: a changed grace window applies to steers that are still waiting,
  // and to every subsequent send, without a relaunch.
  const steerGraceWindowMs = useSteerGraceWindowMs();
  const preferencesHydrated = useMobilePreferencesHydrated();
  const shellStatuses = useThreadOutboxShellStatuses();
  const threads = useThreadShells();
  const projects = useProjects();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());
  // Threads whose queue is being released as one batch, and the ids that batch
  // covers. Cleared once none of those ids remain queued.
  const flushBatchRef = useRef(new Map<string, ReadonlySet<MessageId>>());

  // A batch is done once nothing it covered is queued any more. This must stay
  // declared ahead of the dispatch effect below: a spent batch that outlived
  // its rows would suppress the next turn end's batch for a whole pass.
  useEffect(() => {
    for (const [threadKey, batchIds] of flushBatchRef.current) {
      const remaining = queuedMessagesByThreadKey[threadKey] ?? [];
      const batched = remaining.filter((message) => batchIds.has(message.messageId));
      if (batched.length === 0) {
        flushBatchRef.current.delete(threadKey);
        continue;
      }
      // A batch means "the turn our leader started is still the one running".
      // Losing the environment ends that guarantee: another client may start a
      // turn while we are away, and these messages were queued to follow ours,
      // not to steer into someone else's.
      const environmentId = batched[0]?.environmentId;
      const stillConnected = connectedEnvironments.some(
        (connected) =>
          connected.environmentId === environmentId && connected.connectionState === "connected",
      );
      if (!stillConnected) {
        flushBatchRef.current.delete(threadKey);
      }
    }
  }, [connectedEnvironments, dispatchingQueuedMessageId, queuedMessagesByThreadKey]);

  // Keep expedite state only while its row is queued or owned by an in-flight
  // edit/removal. The ownership checks avoid pruning during the manager's
  // optimistic removal window if durable storage later restores the row.
  useEffect(() => {
    const retainedMessageIds = new Set(
      flattenQueuedThreadMessages(queuedMessagesByThreadKey).map(({ messageId }) => messageId),
    );
    if (dispatchingQueuedMessageId !== null) {
      retainedMessageIds.add(dispatchingQueuedMessageId);
    }
    for (const messageId of Object.keys(editingQueuedMessageIds) as MessageId[]) {
      retainedMessageIds.add(messageId);
    }
    const nextExpeditedIds = pruneExpeditedQueuedMessageIds(
      expeditedMessageIds,
      retainedMessageIds,
    );
    if (nextExpeditedIds !== expeditedMessageIds) {
      appAtomRegistry.set(expeditedQueuedMessageIdsAtom, nextExpeditedIds);
    }
  }, [
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    expeditedMessageIds,
    queuedMessagesByThreadKey,
  ]);

  // Nothing else re-renders when a steer's grace window runs out, so wake the
  // drain as the soonest one comes due.
  useEffect(() => {
    if (!preferencesHydrated) {
      return;
    }
    const soonestGraceMs = soonestSteerGraceRemainingMs(
      flattenQueuedThreadMessages(queuedMessagesByThreadKey),
      Date.now(),
      steerGraceWindowMs,
    );
    if (soonestGraceMs === null) {
      return;
    }
    const graceTimer = setTimeout(() => {
      setRetryTick((current) => current + 1);
    }, soonestGraceMs);
    return () => clearTimeout(graceTimer);
  }, [preferencesHydrated, queuedMessagesByThreadKey, retryTick, steerGraceWindowMs]);

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
        onDelivered: (message, thread, context) => {
          if (thread.archivedAt != null) {
            refreshArchivedThreadsForEnvironment(message.environmentId);
          }
          noteThreadSteerDispatch(message, context);
        },
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
          isThreadOutboxMessageWaitingForPreferences(
            message,
            preferencesHydrated,
            Boolean(expeditedMessageIds[message.messageId]),
          ) ||
          Boolean(editingQueuedMessageIds[message.messageId]) ||
          isSteerWaitingOutGraceWindow(message, {
            nowMs: Date.now(),
            expedited: expeditedMessageIds,
            graceWindowMs: steerGraceWindowMs,
          }) ||
          (retryNotBeforeRef.current.get(message.messageId) ?? 0) > Date.now(),
        resolveAction: (message) => {
          const thread = findThreadIncludingLoadedDetail(threads, message);
          const threadSettings = thread ?? message.threadSettings;
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
            threadExists: threadSettings !== undefined,
            shellStatus,
            environmentConnected: environment?.connectionState === "connected",
            threadStatus: thread?.session?.status ?? null,
            // The turn this batch waited for has ended and its first message
            // started the next one, so the rest follow it in as steers rather
            // than each waiting out a whole turn. Resolving as a steer bypasses
            // only the running-turn hold — a disconnected environment or a
            // shell that is not live still waits.
            deliveryIntent: flushBatchRef.current.get(threadKey)?.has(message.messageId)
              ? "steer"
              : queuedThreadMessageIntent(message),
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
      // Enqueues publish optimistically before their durable write settles.
      // Confirm the write landed (and the message wasn't rolled back) before
      // sending, so a failed write can never chase an already-delivered turn.
      const dispatch = confirmThreadOutboxMessageQueued(nextQueuedMessage).then((queued) => {
        if (!queued) {
          // Rolled back by a failed write; nothing to deliver or retry.
          return true;
        }
        // The guards evaluated before the confirmation await are stale by now:
        // the thread may have gone busy, or the user may have opened this
        // message in the editor. Re-read both and defer to the next drain pass
        // (returning true skips the failure/backoff path) rather than sending
        // a payload the user is editing or racing an active turn.
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[nextQueuedMessage.messageId]) {
          return true;
        }
        const freshThread = findThreadIncludingLoadedDetail(
          appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
          nextQueuedMessage,
        );
        const freshThreadSettings = freshThread ?? nextQueuedMessage.threadSettings;
        const freshThreadBusy =
          freshThread?.session?.status === "running" || freshThread?.session?.status === "starting";
        if (
          candidate.action === "send" &&
          creation === undefined &&
          queuedThreadMessageIntent(nextQueuedMessage) !== "steer" &&
          freshThreadBusy
        ) {
          return true;
        }
        return candidate.action === "remove"
          ? removeQueuedMessage("[thread-outbox] failed to remove message for a missing thread")
          : creation !== undefined
            ? creationProjectCwd !== null
              ? sendQueuedCreation(nextQueuedMessage, creation, creationProjectCwd)
              : removeQueuedMessage("[thread-outbox] dropped pending task for a missing project")
            : freshThreadSettings !== undefined
              ? delivery.sendQueuedMessage(nextQueuedMessage, freshThreadSettings, {
                  sessionStatus: freshThread?.session?.status ?? null,
                  latestTurnId: freshThread?.latestTurn?.turnId ?? null,
                })
              : Promise.resolve(false);
      });
      void dispatch
        .then((sent) => {
          if (!flushBatchRef.current.has(threadKey)) {
            const batchIds = queueFlushBatchIds(queuedMessages, nextQueuedMessage, {
              delivered: sent,
              action: candidate.action,
              threadStatus: thread?.session?.status ?? null,
            });
            if (batchIds.size > 0) {
              flushBatchRef.current.set(threadKey, batchIds);
            }
          }
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
    expeditedMessageIds,
    preferencesHydrated,
    projects,
    queuedMessagesByThreadKey,
    retryTick,
    sendQueuedCreation,
    shellStatuses,
    steerGraceWindowMs,
    threads,
  ]);
}
