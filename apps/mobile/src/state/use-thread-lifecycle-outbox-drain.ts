import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { CommandId, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";

import { refreshArchivedThreadsForEnvironment } from "../features/archive/useArchivedThreadSnapshots";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { environmentShell } from "./shell";
import { threadLifecycleOutboxManager } from "./thread-lifecycle-outbox";
import { deliverThreadLifecycleIntent } from "./thread-lifecycle-outbox-delivery";
import {
  createThreadLifecycleDispatchFence,
  resolveThreadLifecycleOutboxAction,
  type ThreadLifecycleIntent,
  type ThreadLifecycleOutboxAction,
} from "./thread-lifecycle-outbox-model";
import { threadOutboxManager, threadOutboxRetryDelayMs } from "./thread-outbox";
import { environmentThreadShells, threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import { queuedThreadKeysAtom } from "./use-thread-outbox";

const EMPTY_SHELL_STATUSES: ReadonlyMap<EnvironmentId, EnvironmentShellStatus> = new Map();
const EMPTY_SHELL_SEQUENCES: ReadonlyMap<EnvironmentId, number> = new Map();
const EMPTY_PRESENTATIONS: ReadonlyMap<EnvironmentId, EnvironmentPresentation> = new Map();
const EMPTY_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];
const EMPTY_THREAD_KEYS: ReadonlySet<string> = new Set();

/** Inputs the drain re-reads before every step, so each decision sees current state. */
const threadLifecycleOutboxInputsAtom = Atom.make((get) => {
  const intents = get(threadLifecycleOutboxManager.intentsByThreadKeyAtom);
  const loadState = get(threadLifecycleOutboxManager.loadStateAtom);
  // With nothing queued, skip the shell subscriptions so thread updates don't
  // re-render the worker.
  if (Object.keys(intents).length === 0) {
    return {
      intents,
      loadState,
      shellStatuses: EMPTY_SHELL_STATUSES,
      shellSequences: EMPTY_SHELL_SEQUENCES,
      presentations: EMPTY_PRESENTATIONS,
      threads: EMPTY_THREADS,
      queuedThreadKeys: EMPTY_THREAD_KEYS,
    };
  }
  const shellStatuses: Map<EnvironmentId, EnvironmentShellStatus> = new Map();
  const shellSequences: Map<EnvironmentId, number> = new Map();
  for (const intent of Object.values(intents)) {
    if (!shellStatuses.has(intent.environmentId)) {
      const shell = get(environmentShell.stateValueAtom(intent.environmentId));
      shellStatuses.set(intent.environmentId, shell.status);
      if (Option.isSome(shell.snapshot)) {
        shellSequences.set(intent.environmentId, shell.snapshot.value.snapshotSequence);
      }
    }
  }
  return {
    intents,
    loadState,
    shellStatuses,
    shellSequences,
    presentations: get(environmentPresentations.presentationsAtom),
    threads: get(environmentThreadShells.threadShellsAtom),
    queuedThreadKeys: get(queuedThreadKeysAtom),
  };
}).pipe(Atom.withLabel("mobile:thread-lifecycle-outbox:inputs"));

type ThreadLifecycleOutboxInputs = Atom.Type<typeof threadLifecycleOutboxInputsAtom>;

function liveThread(inputs: ThreadLifecycleOutboxInputs, intent: ThreadLifecycleIntent) {
  return inputs.threads.find(
    (thread) => thread.environmentId === intent.environmentId && thread.id === intent.threadId,
  );
}

/** Backoff follows the user's revision across command-id rotations. */
function retryKey(threadKey: string, intent: ThreadLifecycleIntent): string {
  return `${threadKey}@${intent.createdAt}`;
}

/** Our last successful command per environment; in memory, as a reload resnapshots the shell. */
const dispatchFence = createThreadLifecycleDispatchFence();

function resolveIntentAction(
  inputs: ThreadLifecycleOutboxInputs,
  intent: ThreadLifecycleIntent,
  threadKey: string,
): ThreadLifecycleOutboxAction {
  // The inputs atom re-runs the drain once the shell catches up.
  if (
    dispatchFence.holds(
      intent.environmentId,
      inputs.shellSequences.get(intent.environmentId) ?? null,
    )
  ) {
    return "wait";
  }
  return resolveThreadLifecycleOutboxAction({
    environmentConnected:
      inputs.presentations.get(intent.environmentId)?.connection.phase === "connected",
    shellStatus: inputs.shellStatuses.get(intent.environmentId) ?? "empty",
    hasQueuedMessages: inputs.queuedThreadKeys.has(threadKey),
    thread: liveThread(inputs, intent),
    desiredArchived: intent.desiredArchived,
    requiresDispatch: intent.requiresDispatch,
  });
}

export const dispatchingThreadLifecycleIntentCommandIdAtom = Atom.make<CommandId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-lifecycle-outbox:dispatching-command-id"),
);

/** Applies queued offline archive/unarchive intents once their environment is live. */
export function useThreadLifecycleOutboxDrain(): void {
  const scheduleArchive = useAtomCommand(threadEnvironment.scheduleArchive, {
    reportFailure: false,
  });
  const cancelArchive = useAtomCommand(threadEnvironment.cancelArchive, { reportFailure: false });
  const unarchive = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const inputs = useAtomValue(threadLifecycleOutboxInputsAtom);
  const dispatchingCommandId = useAtomValue(dispatchingThreadLifecycleIntentCommandIdAtom);
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<string, number>());
  const retryNotBeforeRef = useRef(new Map<string, number>());
  const retryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const hydrationRetryAttemptRef = useRef(0);

  const { loadState } = inputs;
  useEffect(() => {
    if (loadState.status === "ready") {
      hydrationRetryAttemptRef.current = 0;
      return;
    }
    if (loadState.status === "loading") return;
    if (loadState.status === "idle") {
      void threadLifecycleOutboxManager.load();
      return;
    }
    hydrationRetryAttemptRef.current += 1;
    const timer = setTimeout(
      () => void threadLifecycleOutboxManager.load(),
      threadOutboxRetryDelayMs(hydrationRetryAttemptRef.current),
    );
    return () => clearTimeout(timer);
  }, [loadState]);

  useEffect(() => {
    const timers = retryTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (dispatchingCommandId !== null) return;

    for (const [threadKey, intent] of Object.entries(inputs.intents)) {
      const intentRetryKey = retryKey(threadKey, intent);
      if ((retryNotBeforeRef.current.get(intentRetryKey) ?? 0) > Date.now()) continue;
      if (resolveIntentAction(inputs, intent, threadKey) === "wait") continue;

      appAtomRegistry.set(dispatchingThreadLifecycleIntentCommandIdAtom, intent.commandId);
      void deliverThreadLifecycleIntent(intent, {
        manager: threadLifecycleOutboxManager,
        loadMessageOutbox: threadOutboxManager.load,
        readAction: (candidate) =>
          resolveIntentAction(
            appAtomRegistry.get(threadLifecycleOutboxInputsAtom),
            candidate,
            threadKey,
          ),
        dispatch: (action, candidate) => {
          const input = { threadId: candidate.threadId, commandId: candidate.commandId };
          const environmentId = candidate.environmentId;
          if (action === "archive") {
            return scheduleArchive({ environmentId, input: { ...input, afterTurn: true } });
          }
          return (action === "unarchive" ? unarchive : cancelArchive)({ environmentId, input });
        },
        onSettled: (candidate, sequence) => {
          if (sequence !== null) dispatchFence.record(candidate.environmentId, sequence);
          refreshArchivedThreadsForEnvironment(candidate.environmentId);
        },
        threadActive: (candidate) =>
          threadRuntimeIsActive(
            liveThread(appAtomRegistry.get(threadLifecycleOutboxInputsAtom), candidate)?.runtime,
          ),
        newCommandId: () => CommandId.make(uuidv4()),
      })
        .then((handled) => {
          const previousTimer = retryTimersRef.current.get(intentRetryKey);
          if (previousTimer !== undefined) clearTimeout(previousTimer);
          retryTimersRef.current.delete(intentRetryKey);
          if (handled) {
            retryAttemptRef.current.delete(intentRetryKey);
            retryNotBeforeRef.current.delete(intentRetryKey);
            return;
          }
          const attempt = (retryAttemptRef.current.get(intentRetryKey) ?? 0) + 1;
          retryAttemptRef.current.set(intentRetryKey, attempt);
          const delay = threadOutboxRetryDelayMs(attempt);
          retryNotBeforeRef.current.set(intentRetryKey, Date.now() + delay);
          retryTimersRef.current.set(
            intentRetryKey,
            setTimeout(() => {
              retryTimersRef.current.delete(intentRetryKey);
              setRetryTick((current) => current + 1);
            }, delay),
          );
        })
        .finally(() => {
          if (
            appAtomRegistry.get(dispatchingThreadLifecycleIntentCommandIdAtom) === intent.commandId
          ) {
            appAtomRegistry.set(dispatchingThreadLifecycleIntentCommandIdAtom, null);
          }
        });
      return;
    }
  }, [cancelArchive, dispatchingCommandId, inputs, retryTick, scheduleArchive, unarchive]);
}
