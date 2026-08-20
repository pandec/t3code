import { useAtomValue } from "@effect/atom-react";
import {
  resolveThreadLifecycleOutboxAction,
  resolveThreadLifecycleOutboxFailureAction,
  threadLifecycleOutboxRetryDelayMs,
  type ThreadLifecycleIntent,
} from "@t3tools/client-runtime/state/thread-lifecycle-outbox-model";
import type {
  EnvironmentShellState,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { type CommandId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";

import { refreshArchivedThreadsForEnvironment } from "../features/archive/useArchivedThreadSnapshots";
import { appAtomRegistry } from "./atom-registry";
import { useThreadShells } from "./entities";
import { environmentShell } from "./shell";
import {
  confirmThreadLifecycleIntentCurrent,
  ensureThreadLifecycleOutboxLoaded,
  removeThreadLifecycleIntentIfCurrent,
  threadLifecycleOutboxManager,
  useThreadLifecycleIntents,
} from "./thread-lifecycle-outbox";
import { threadOutboxManager } from "./thread-outbox";
import { environmentThreadShells, threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import { useThreadOutboxMessages } from "./use-thread-outbox";
import { dispatchingQueuedMessageThreadKeyAtom } from "./use-thread-outbox-drain";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";

export const dispatchingThreadLifecycleIntentCommandIdAtom = Atom.make<CommandId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-lifecycle-outbox:dispatching-command-id"),
);

const threadLifecycleOutboxShellStatusesAtom = Atom.make((get) => {
  const statuses = new Map<string, EnvironmentShellState>();
  for (const intent of Object.values(get(threadLifecycleOutboxManager.intentsByThreadKeyAtom))) {
    if (!statuses.has(intent.environmentId)) {
      statuses.set(
        intent.environmentId,
        get(environmentShell.stateValueAtom(intent.environmentId)),
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

export function useThreadLifecycleOutboxDrain(): void {
  const archiveThread = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveThread = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const intents = useThreadLifecycleIntents();
  const shellStates = useAtomValue(threadLifecycleOutboxShellStatusesAtom);
  const threads = useThreadShells();
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const dispatchingMessageThreadKey = useAtomValue(dispatchingQueuedMessageThreadKeyAtom);
  const dispatchingCommandId = useAtomValue(dispatchingThreadLifecycleIntentCommandIdAtom);
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<CommandId, number>());
  const retryNotBeforeRef = useRef(new Map<CommandId, number>());
  const retryTimersRef = useRef(new Map<CommandId, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    ensureThreadLifecycleOutboxLoaded();
    return () => {
      for (const timer of retryTimersRef.current.values()) clearTimeout(timer);
      retryTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (dispatchingCommandId !== null) return;

    for (const [threadKey, intent] of Object.entries(intents)) {
      if ((retryNotBeforeRef.current.get(intent.commandId) ?? 0) > Date.now()) continue;
      const thread = findThread(threads, intent);
      const shellStatus = shellStates.get(intent.environmentId)?.status ?? "empty";
      const connected = connectedEnvironments.some(
        (environment) =>
          environment.environmentId === intent.environmentId &&
          environment.connectionState === "connected",
      );
      const action = resolveThreadLifecycleOutboxAction({
        environmentConnected: connected,
        shellStatus,
        threadExists: thread !== undefined,
        threadArchived: thread?.archivedAt != null,
        desiredArchived: intent.desiredArchived,
        requiresDispatch: intent.requiresDispatch,
        hasQueuedMessages: (queuedMessagesByThreadKey[threadKey]?.length ?? 0) > 0,
        messageDispatching: dispatchingMessageThreadKey === threadKey,
        hasActiveTurn: thread?.session?.status === "running" && thread.session.activeTurnId != null,
      });
      if (action === "wait") continue;

      appAtomRegistry.set(dispatchingThreadLifecycleIntentCommandIdAtom, intent.commandId);
      const removeCurrent = async (): Promise<boolean> => {
        try {
          await removeThreadLifecycleIntentIfCurrent(intent);
          return true;
        } catch (error) {
          console.warn("[thread-lifecycle-outbox] failed to remove intent", {
            environmentId: intent.environmentId,
            threadId: intent.threadId,
            commandId: intent.commandId,
            error,
          });
          return false;
        }
      };
      const dispatch = confirmThreadLifecycleIntentCurrent(intent).then(async (current) => {
        if (!current) return true;
        if (action === "remove") return removeCurrent();

        // Canonical shells only: optimistic lifecycle presentation must not
        // affect ordering or active-turn guards.
        const freshThread = findThread(
          appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
          intent,
        );
        const freshMessages = appAtomRegistry.get(
          threadOutboxManager.queuedMessagesByThreadKeyAtom,
        );
        const freshAction = resolveThreadLifecycleOutboxAction({
          environmentConnected: connected,
          shellStatus: appAtomRegistry.get(environmentShell.stateValueAtom(intent.environmentId))
            .status,
          threadExists: freshThread !== undefined,
          threadArchived: freshThread?.archivedAt != null,
          desiredArchived: intent.desiredArchived,
          requiresDispatch: intent.requiresDispatch,
          hasQueuedMessages: (freshMessages[threadKey]?.length ?? 0) > 0,
          messageDispatching:
            appAtomRegistry.get(dispatchingQueuedMessageThreadKeyAtom) === threadKey,
          hasActiveTurn:
            freshThread?.session?.status === "running" && freshThread.session.activeTurnId != null,
        });
        if (freshAction === "wait") return true;
        if (freshAction === "remove") return removeCurrent();

        const result = await (freshAction === "archive" ? archiveThread : unarchiveThread)({
          environmentId: intent.environmentId,
          input: { threadId: intent.threadId, commandId: intent.commandId },
        });
        if (AsyncResult.isSuccess(result)) {
          refreshArchivedThreadsForEnvironment(intent.environmentId);
          return removeCurrent();
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
        return removeCurrent();
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
    queuedMessagesByThreadKey,
    retryTick,
    shellStates,
    threads,
    unarchiveThread,
  ]);
}
