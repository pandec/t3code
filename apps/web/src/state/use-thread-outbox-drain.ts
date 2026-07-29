import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { createThreadOutboxDelivery } from "@t3tools/client-runtime/state/thread-outbox-delivery";
import {
  flattenQueuedThreadMessages,
  isSteerWaitingOutGraceWindow,
  pruneExpeditedQueuedMessageIds,
  queueFlushBatchIds,
  queuedThreadMessageIntent,
  resolveThreadOutboxDeliveryAction,
  scopedThreadKey,
  selectNextQueuedThreadDispatch,
  soonestSteerGraceRemainingMs,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "@t3tools/client-runtime/state/thread-outbox-model";
import type { EnvironmentId, MessageId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useClientSettingsHydrated, useSteerGraceWindowMs } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useThreadShells } from "./entities";
import { environmentShell } from "./shell";
import {
  dispatchingQueuedMessageAtom,
  editingQueuedMessageIdsAtom,
  expeditedQueuedMessageIdsAtom,
  ensureThreadOutboxLoaded,
  isThreadOutboxMessageWaitingForClientSettings,
  removeThreadOutboxMessage,
  threadOutboxManager,
  useThreadOutboxMessages,
} from "./threadOutbox";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

const threadOutboxShellStatusesAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, EnvironmentShellStatus> => {
    const statuses = new Map<EnvironmentId, EnvironmentShellStatus>();
    for (const queue of Object.values(get(threadOutboxManager.queuedMessagesByThreadKeyAtom))) {
      const environmentId = queue[0]?.environmentId;
      if (environmentId !== undefined && !statuses.has(environmentId)) {
        statuses.set(environmentId, get(environmentShell.stateValueAtom(environmentId)).status);
      }
    }
    return statuses;
  },
).pipe(Atom.withLabel("web:thread-outbox:shell-statuses"));

const threadOutboxEnvironmentConnectivityAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, boolean> => {
    const connectivity = new Map<EnvironmentId, boolean>();
    for (const queue of Object.values(get(threadOutboxManager.queuedMessagesByThreadKeyAtom))) {
      const environmentId = queue[0]?.environmentId;
      if (environmentId !== undefined && !connectivity.has(environmentId)) {
        const connection = Option.getOrElse(
          AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
          () => AVAILABLE_CONNECTION_STATE,
        );
        connectivity.set(environmentId, connection.phase === "connected");
      }
    }
    return connectivity;
  },
).pipe(Atom.withLabel("web:thread-outbox:environment-connectivity"));

function beginDispatchingQueuedMessage(queuedMessage: QueuedThreadMessage): void {
  appAtomRegistry.set(dispatchingQueuedMessageAtom, queuedMessage);
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageAtom);
  appAtomRegistry.set(
    dispatchingQueuedMessageAtom,
    current?.messageId === queuedMessageId ? null : current,
  );
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

/**
 * Delivers queued thread messages: "queue" intent once the thread's turn
 * settles, "steer" intent immediately (the server treats a turn start on a
 * running thread as a steer). Unlike mobile there is no creation branch —
 * pending-task creation messages are left alone for the mobile client.
 */
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
  const dispatchingQueuedMessage = useAtomValue(dispatchingQueuedMessageAtom);
  const editingQueuedMessageIds = useAtomValue(editingQueuedMessageIdsAtom);
  const expeditedMessageIds = useAtomValue(expeditedQueuedMessageIdsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  // Read live: a changed grace window applies to steers that are still waiting,
  // and to every subsequent send, without a reload.
  const steerGraceWindowMs = useSteerGraceWindowMs();
  const clientSettingsHydrated = useClientSettingsHydrated();
  const shellStatuses = useAtomValue(threadOutboxShellStatusesAtom);
  const environmentConnectivity = useAtomValue(threadOutboxEnvironmentConnectivityAtom);
  const threads = useThreadShells();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());
  // Threads whose queue is being released as one batch, and the ids that batch
  // covers. Cleared once none of those ids remain queued.
  const flushBatchRef = useRef(new Map<string, ReadonlySet<MessageId>>());

  useEffect(() => {
    ensureThreadOutboxLoaded();
    const retryTimers = retryTimersRef.current;
    return () => {
      for (const timer of retryTimers.values()) {
        clearTimeout(timer);
      }
      retryTimers.clear();
    };
  }, []);

  // Nothing else re-renders when a steer's grace window runs out, so wake the
  // drain as the soonest one comes due.
  useEffect(() => {
    if (!clientSettingsHydrated) {
      return;
    }
    const now = Date.now();
    const soonestGraceMs = soonestSteerGraceRemainingMs(
      flattenQueuedThreadMessages(queuedMessagesByThreadKey),
      now,
      steerGraceWindowMs,
    );
    if (soonestGraceMs === null) {
      return;
    }
    const graceTimer = setTimeout(() => {
      setRetryTick((current) => current + 1);
    }, soonestGraceMs);
    return () => clearTimeout(graceTimer);
  }, [clientSettingsHydrated, queuedMessagesByThreadKey, retryTick, steerGraceWindowMs]);

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
      if (environmentId !== undefined && environmentConnectivity.get(environmentId) !== true) {
        flushBatchRef.current.delete(threadKey);
      }
    }
  }, [dispatchingQueuedMessage, environmentConnectivity, queuedMessagesByThreadKey]);

  // Keep expedite state only while its row is queued or owned by an in-flight
  // edit/removal. The ownership checks avoid pruning during the manager's
  // optimistic removal window if durable storage later restores the row.
  useEffect(() => {
    const retainedMessageIds = new Set(
      flattenQueuedThreadMessages(queuedMessagesByThreadKey).map(({ messageId }) => messageId),
    );
    if (dispatchingQueuedMessage !== null) {
      retainedMessageIds.add(dispatchingQueuedMessage.messageId);
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
    dispatchingQueuedMessage,
    editingQueuedMessageIds,
    expeditedMessageIds,
    queuedMessagesByThreadKey,
  ]);

  useEffect(() => {
    if (dispatchingQueuedMessage !== null) {
      return;
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const candidate = selectNextQueuedThreadDispatch(queuedMessages, {
        isHeld: (message) =>
          isThreadOutboxMessageWaitingForClientSettings(message, clientSettingsHydrated) ||
          Boolean(editingQueuedMessageIds[message.messageId]) ||
          isSteerWaitingOutGraceWindow(message, {
            nowMs: Date.now(),
            expedited: expeditedMessageIds,
            graceWindowMs: steerGraceWindowMs,
          }) ||
          (retryNotBeforeRef.current.get(message.messageId) ?? 0) > Date.now(),
        resolveAction: (message) => {
          if (message.creation !== undefined) {
            return "wait";
          }
          const thread = findThread(threads, message);
          if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
            return "wait";
          }
          return resolveThreadOutboxDeliveryAction({
            isCreation: false,
            threadExists: thread !== undefined,
            shellStatus: shellStatuses.get(message.environmentId) ?? "empty",
            environmentConnected: environmentConnectivity.get(message.environmentId) === true,
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
        },
      });
      if (candidate === null) {
        continue;
      }
      const nextQueuedMessage = candidate.message;
      const thread = findThread(threads, nextQueuedMessage);

      beginDispatchingQueuedMessage(nextQueuedMessage);
      const dispatch =
        candidate.action === "remove"
          ? removeThreadOutboxMessage(nextQueuedMessage).then(
              () => true,
              (error) => {
                console.warn("[thread-outbox] failed to remove message for a missing thread", {
                  environmentId: nextQueuedMessage.environmentId,
                  threadId: nextQueuedMessage.threadId,
                  messageId: nextQueuedMessage.messageId,
                  error,
                });
                return false;
              },
            )
          : thread !== undefined
            ? delivery.sendQueuedMessage(nextQueuedMessage, thread)
            : Promise.resolve(false);
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
    delivery,
    clientSettingsHydrated,
    dispatchingQueuedMessage,
    editingQueuedMessageIds,
    environmentConnectivity,
    expeditedMessageIds,
    queuedMessagesByThreadKey,
    retryTick,
    shellStatuses,
    steerGraceWindowMs,
    threads,
  ]);
}
