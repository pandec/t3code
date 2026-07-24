import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { createThreadOutboxDelivery } from "@t3tools/client-runtime/state/thread-outbox-delivery";
import {
  queuedThreadMessageIntent,
  resolveThreadOutboxDeliveryAction,
  scopedThreadKey,
  selectNextQueuedThreadDispatch,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "@t3tools/client-runtime/state/thread-outbox-model";
import type { EnvironmentId, MessageId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useThreadShells } from "./entities";
import { environmentShell } from "./shell";
import {
  dispatchingQueuedMessageIdAtom,
  editingQueuedMessageIdsAtom,
  ensureThreadOutboxLoaded,
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
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const editingQueuedMessageIds = useAtomValue(editingQueuedMessageIdsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const shellStatuses = useAtomValue(threadOutboxShellStatusesAtom);
  const environmentConnectivity = useAtomValue(threadOutboxEnvironmentConnectivityAtom);
  const threads = useThreadShells();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());

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
            deliveryIntent: queuedThreadMessageIntent(message),
          });
        },
      });
      if (candidate === null) {
        continue;
      }
      const nextQueuedMessage = candidate.message;
      const thread = findThread(threads, nextQueuedMessage);

      beginDispatchingQueuedMessage(nextQueuedMessage.messageId);
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
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    environmentConnectivity,
    queuedMessagesByThreadKey,
    retryTick,
    shellStatuses,
    threads,
  ]);
}
