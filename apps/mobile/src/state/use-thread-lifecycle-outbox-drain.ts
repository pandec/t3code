import { useAtomValue } from "@effect/atom-react";
import {
  resolveThreadLifecycleOutboxAction,
  resolveThreadLifecycleOutboxFailureAction,
  threadLifecycleOutboxRetryDelayMs,
  type ThreadLifecycleIntent,
} from "@t3tools/client-runtime/state/thread-lifecycle-outbox-model";
import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { CommandId, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";

import { refreshArchivedThreadsForEnvironment } from "../features/archive/useArchivedThreadSnapshots";
import { appAtomRegistry } from "./atom-registry";
import { useThreadShells } from "./entities";
import { environmentPresentations } from "./presentation";
import { environmentShell } from "./shell";
import {
  confirmThreadLifecycleIntentCurrent,
  ensureThreadLifecycleOutboxLoaded,
  markThreadLifecycleIntentDispatchAttempted,
  removeThreadLifecycleIntentIfCurrent,
  threadLifecycleOutboxManager,
  useThreadLifecycleIntents,
  useThreadLifecycleOutboxLoadState,
} from "./thread-lifecycle-outbox";
import {
  prepareThreadLifecycleDispatch,
  type PreparedThreadLifecycleDispatch,
} from "./thread-lifecycle-dispatch";
import { threadOutboxManager } from "./thread-outbox";
import { environmentThreadShells, threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import {
  threadOutboxProjectionHoldsAtom,
  useThreadOutboxLoadState,
  useThreadOutboxMessages,
  useThreadOutboxProjectionHolds,
} from "./use-thread-outbox";
import { dispatchingQueuedMessageThreadKeyAtom } from "./use-thread-outbox-drain";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";

export const dispatchingThreadLifecycleIntentCommandIdAtom = Atom.make<CommandId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-lifecycle-outbox:dispatching-command-id"),
);

const threadLifecycleOutboxShellStatusesAtom = Atom.make((get) => {
  const statuses = new Map<EnvironmentId, EnvironmentShellStatus>();
  for (const intent of Object.values(get(threadLifecycleOutboxManager.intentsByThreadKeyAtom))) {
    if (!statuses.has(intent.environmentId)) {
      statuses.set(
        intent.environmentId,
        get(environmentShell.stateValueAtom(intent.environmentId)).status,
      );
    }
  }
  return statuses;
}).pipe(Atom.withLabel("mobile:thread-lifecycle-outbox:shell-statuses"));

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  intent: ThreadLifecycleIntent,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (thread) => thread.environmentId === intent.environmentId && thread.id === intent.threadId,
  );
}

function readCurrentThreadLifecycleAction(intent: ThreadLifecycleIntent, threadKey: string) {
  const thread = findThread(appAtomRegistry.get(environmentThreadShells.threadShellsAtom), intent);
  const messages = appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom);
  return resolveThreadLifecycleOutboxAction({
    environmentConnected:
      appAtomRegistry.get(environmentPresentations.presentationsAtom).get(intent.environmentId)
        ?.connection.phase === "connected",
    shellStatus: appAtomRegistry.get(environmentShell.stateValueAtom(intent.environmentId)).status,
    messageOutboxReady: appAtomRegistry.get(threadOutboxManager.loadStateAtom).status === "ready",
    threadExists: thread !== undefined,
    threadArchived: thread?.archivedAt != null,
    desiredArchived: intent.desiredArchived,
    requiresDispatch: intent.requiresDispatch,
    hasQueuedMessages: (messages[threadKey]?.length ?? 0) > 0,
    messageDispatching: appAtomRegistry.get(dispatchingQueuedMessageThreadKeyAtom) === threadKey,
    messageProjectionPending:
      appAtomRegistry.get(threadOutboxProjectionHoldsAtom)[threadKey] !== undefined,
    threadBusy:
      thread?.session?.status === "starting" ||
      (thread?.session?.status === "running" && thread.session.activeTurnId != null),
  });
}

export function useThreadLifecycleOutboxDrain(): void {
  const archiveThread = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveThread = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const intents = useThreadLifecycleIntents();
  const lifecycleLoadState = useThreadLifecycleOutboxLoadState();
  const shellStates = useAtomValue(threadLifecycleOutboxShellStatusesAtom);
  const threads = useThreadShells();
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const messageOutboxLoadState = useThreadOutboxLoadState();
  const messageProjectionHolds = useThreadOutboxProjectionHolds();
  const dispatchingMessageThreadKey = useAtomValue(dispatchingQueuedMessageThreadKeyAtom);
  const dispatchingCommandId = useAtomValue(dispatchingThreadLifecycleIntentCommandIdAtom);
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<CommandId, number>());
  const hydrationRetryAttemptRef = useRef(0);
  const hydrationRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryNotBeforeRef = useRef(new Map<CommandId, number>());
  const retryTimersRef = useRef(new Map<CommandId, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (lifecycleLoadState.status === "ready") {
      hydrationRetryAttemptRef.current = 0;
      return;
    }
    if (lifecycleLoadState.status === "loading") return;
    if (lifecycleLoadState.status === "idle") {
      void ensureThreadLifecycleOutboxLoaded();
      return;
    }

    hydrationRetryAttemptRef.current += 1;
    const delay = threadLifecycleOutboxRetryDelayMs(hydrationRetryAttemptRef.current);
    hydrationRetryTimerRef.current = setTimeout(() => {
      hydrationRetryTimerRef.current = null;
      void ensureThreadLifecycleOutboxLoaded();
    }, delay);
    return () => {
      if (hydrationRetryTimerRef.current !== null) {
        clearTimeout(hydrationRetryTimerRef.current);
        hydrationRetryTimerRef.current = null;
      }
    };
  }, [lifecycleLoadState]);

  useEffect(
    () => () => {
      if (hydrationRetryTimerRef.current !== null) clearTimeout(hydrationRetryTimerRef.current);
      for (const timer of retryTimersRef.current.values()) clearTimeout(timer);
      retryTimersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (dispatchingCommandId !== null) return;

    for (const [threadKey, intent] of Object.entries(intents)) {
      if ((retryNotBeforeRef.current.get(intent.commandId) ?? 0) > Date.now()) continue;
      const thread = findThread(threads, intent);
      const shellStatus = shellStates.get(intent.environmentId) ?? "empty";
      const connected = connectedEnvironments.some(
        (environment) =>
          environment.environmentId === intent.environmentId &&
          environment.connectionState === "connected",
      );
      const action = resolveThreadLifecycleOutboxAction({
        environmentConnected: connected,
        shellStatus,
        messageOutboxReady: messageOutboxLoadState.status === "ready",
        threadExists: thread !== undefined,
        threadArchived: thread?.archivedAt != null,
        desiredArchived: intent.desiredArchived,
        requiresDispatch: intent.requiresDispatch,
        hasQueuedMessages: (queuedMessagesByThreadKey[threadKey]?.length ?? 0) > 0,
        messageDispatching: dispatchingMessageThreadKey === threadKey,
        messageProjectionPending: messageProjectionHolds[threadKey] !== undefined,
        threadBusy:
          thread?.session?.status === "starting" ||
          (thread?.session?.status === "running" && thread.session.activeTurnId != null),
      });
      if (action === "wait") continue;

      appAtomRegistry.set(dispatchingThreadLifecycleIntentCommandIdAtom, intent.commandId);
      const removeCurrent = async (candidate: ThreadLifecycleIntent = intent): Promise<boolean> => {
        try {
          await removeThreadLifecycleIntentIfCurrent(candidate);
          return true;
        } catch (error) {
          console.warn("[thread-lifecycle-outbox] failed to remove intent", {
            environmentId: candidate.environmentId,
            threadId: candidate.threadId,
            commandId: candidate.commandId,
            error,
          });
          return false;
        }
      };
      const dispatch = confirmThreadLifecycleIntentCurrent(intent).then(async (current) => {
        if (!current) return true;

        // Canonical shells only: optimistic lifecycle presentation must not
        // affect ordering or active-turn guards. Check once before the durable
        // attempt marker to avoid unnecessary compensation, then check again
        // after every await immediately before issuing the command.
        const freshAction = readCurrentThreadLifecycleAction(intent, threadKey);
        if (freshAction === "wait") return true;
        if (freshAction === "remove") return removeCurrent();

        let prepared: PreparedThreadLifecycleDispatch | null;
        try {
          prepared = await prepareThreadLifecycleDispatch({
            intent,
            markDispatchAttempted: markThreadLifecycleIntentDispatchAttempted,
            confirmCurrent: confirmThreadLifecycleIntentCurrent,
            readCurrentAction: (attempted) =>
              readCurrentThreadLifecycleAction(attempted, threadKey),
          });
        } catch (error) {
          console.warn("[thread-lifecycle-outbox] failed to persist dispatch attempt", {
            environmentId: intent.environmentId,
            threadId: intent.threadId,
            commandId: intent.commandId,
            error,
          });
          return false;
        }
        if (prepared === null) return true;
        const attempted = prepared.intent;
        if (prepared.action === "wait") return true;
        if (prepared.action === "remove") return removeCurrent(attempted);

        const result = await (prepared.action === "archive" ? archiveThread : unarchiveThread)({
          environmentId: attempted.environmentId,
          input: { threadId: attempted.threadId, commandId: attempted.commandId },
        });
        if (AsyncResult.isSuccess(result)) {
          refreshArchivedThreadsForEnvironment(intent.environmentId);
          return removeCurrent(attempted);
        }

        const error = Cause.squash(result.cause);
        const failureAction = resolveThreadLifecycleOutboxFailureAction({
          error,
          desiredArchived: intent.desiredArchived,
          interrupted: Cause.hasInterruptsOnly(result.cause),
        });
        console.warn("[thread-lifecycle-outbox] lifecycle delivery failed", {
          environmentId: intent.environmentId,
          threadId: intent.threadId,
          commandId: intent.commandId,
          desiredArchived: intent.desiredArchived,
          failureAction,
          cause: result.cause,
        });
        if (failureAction === "retry") return false;
        if (failureAction === "fulfilled") {
          refreshArchivedThreadsForEnvironment(intent.environmentId);
        }
        return removeCurrent(attempted);
      });

      void dispatch
        .then((handled) => {
          if (handled) {
            retryAttemptRef.current.delete(intent.commandId);
            retryNotBeforeRef.current.delete(intent.commandId);
            const timer = retryTimersRef.current.get(intent.commandId);
            if (timer !== undefined) clearTimeout(timer);
            retryTimersRef.current.delete(intent.commandId);
            return;
          }
          const attempt = (retryAttemptRef.current.get(intent.commandId) ?? 0) + 1;
          retryAttemptRef.current.set(intent.commandId, attempt);
          const delay = threadLifecycleOutboxRetryDelayMs(attempt);
          retryNotBeforeRef.current.set(intent.commandId, Date.now() + delay);
          const previousTimer = retryTimersRef.current.get(intent.commandId);
          if (previousTimer !== undefined) clearTimeout(previousTimer);
          retryTimersRef.current.set(
            intent.commandId,
            setTimeout(() => {
              retryTimersRef.current.delete(intent.commandId);
              setRetryTick((current) => current + 1);
            }, delay),
          );
        })
        .finally(() => {
          const current = appAtomRegistry.get(dispatchingThreadLifecycleIntentCommandIdAtom);
          if (current === intent.commandId) {
            appAtomRegistry.set(dispatchingThreadLifecycleIntentCommandIdAtom, null);
          }
        });
      return;
    }
  }, [
    archiveThread,
    connectedEnvironments,
    dispatchingCommandId,
    dispatchingMessageThreadKey,
    intents,
    messageOutboxLoadState,
    messageProjectionHolds,
    queuedMessagesByThreadKey,
    retryTick,
    shellStates,
    threads,
    unarchiveThread,
  ]);
}
