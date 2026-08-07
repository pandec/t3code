import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  EMPTY_THREAD_OLDER_MESSAGES_STATE,
  type EnvironmentThreadState,
  type ThreadLoadOlderHistoryOptions,
  type ThreadOlderMessagesState,
  createThreadEnvironmentAtoms,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadMessageWindow,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const threadEnvironment = createThreadEnvironmentAtoms(connectionAtomRuntime);
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
  environmentThreads.loadOlderMessagesAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

function latestUserMessageAt(thread: OrchestrationThread): OrchestrationThread["updatedAt"] | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "user") {
      return message.createdAt;
    }
  }
  return null;
}

export function threadDetailToShell(
  environmentId: EnvironmentId,
  thread: OrchestrationThread,
): EnvironmentThreadShell {
  return {
    environmentId,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    snoozedUntil: thread.snoozedUntil ?? null,
    snoozedAt: thread.snoozedAt ?? null,
    movedToTopAt: thread.movedToTopAt ?? null,
    pinnedAt: thread.pinnedAt ?? null,
    session: thread.session,
    latestUserMessageAt: latestUserMessageAt(thread),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("mobile-environment-thread:empty"),
);
const EMPTY_MESSAGES_ATOM = Atom.make<ReadonlyArray<OrchestrationMessage>>([]);
const EMPTY_MESSAGE_WINDOW_ATOM = Atom.make<OrchestrationThreadMessageWindow | null>(null);
const EMPTY_HAS_OLDER_HISTORY_ATOM = Atom.make<boolean>(false);
const EMPTY_OLDER_MESSAGES_ATOM = Atom.make<ThreadOlderMessagesState>(
  EMPTY_THREAD_OLDER_MESSAGES_STATE,
);
const EMPTY_LOAD_OLDER_MESSAGES_ATOM = Atom.writable(
  () => undefined,
  () => undefined,
);

function useScopedThreadRef(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ScopedThreadRef | null {
  return useMemo(
    () => (environmentId === null || threadId === null ? null : { environmentId, threadId }),
    [environmentId, threadId],
  );
}

export function useThreadMessageWindow(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const ref = useScopedThreadRef(environmentId, threadId);
  const messages = useAtomValue(
    ref === null ? EMPTY_MESSAGES_ATOM : environmentThreadDetails.messagesAtom(ref),
  );
  const messageWindow = useAtomValue(
    ref === null ? EMPTY_MESSAGE_WINDOW_ATOM : environmentThreadDetails.messageWindowAtom(ref),
  );
  const olderMessages = useAtomValue(
    ref === null ? EMPTY_OLDER_MESSAGES_ATOM : environmentThreadDetails.olderMessagesAtom(ref),
  );
  // Mode-agnostic: turn-windowed threads carry no `messageWindow`, so the
  // "more history exists" signal must come from the state-level helper.
  const hasOlderMessages = useAtomValue(
    ref === null ? EMPTY_HAS_OLDER_HISTORY_ATOM : environmentThreadDetails.hasOlderHistoryAtom(ref),
  );
  return useMemo(
    () => ({
      messages,
      messageWindow,
      hasOlderMessages,
      loadingOlderMessages: olderMessages.isLoading,
      settledCount: olderMessages.settledCount,
      error: olderMessages.error,
    }),
    [
      hasOlderMessages,
      messageWindow,
      messages,
      olderMessages.error,
      olderMessages.isLoading,
      olderMessages.settledCount,
    ],
  );
}

export function useLoadOlderMessages(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): (options?: ThreadLoadOlderHistoryOptions) => void {
  const ref = useScopedThreadRef(environmentId, threadId);
  const load = useAtomSet(
    ref === null
      ? EMPTY_LOAD_OLDER_MESSAGES_ATOM
      : environmentThreadDetails.loadOlderMessagesAtom(ref),
  );
  // `automatic` requests (underfill recovery) observe the resident-message
  // ceiling; explicit scrollback does not. See ThreadLoadOlderHistoryOptions.
  return useCallback((options?: ThreadLoadOlderHistoryOptions) => load(options), [load]);
}

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  return Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
}
