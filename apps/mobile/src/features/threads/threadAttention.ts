import {
  admitNewAttentionKeys,
  createAttentionFilter,
  hasUnseenWake,
  isThreadAttention,
} from "@t3tools/client-runtime/state/thread-attention";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { isLatestTurnSettled } from "./threadPresentation";
import { resolveThreadListV2Status } from "./threadListV2";

export type ThreadAttentionShell = Pick<
  EnvironmentThreadShell,
  | "backgroundLiveness"
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
>;

// This fork-added helper stays local because upstream's resolveThreadStatusPill
// now consumes its web copy; with hasUnseenCompletion it remains a known drift
// surface rather than deepening fork edits in upstream-owned status logic.
function hasPlanReadyPrompt(thread: ThreadAttentionShell): boolean {
  return (
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan
  );
}

export function hasUnseenCompletion(
  thread: Pick<ThreadAttentionShell, "latestTurn">,
  lastVisitedAt: string | undefined,
): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!lastVisitedAt) return false;

  const lastVisitedAtMs = Date.parse(lastVisitedAt);
  return Number.isNaN(lastVisitedAtMs) || completedAt > lastVisitedAtMs;
}

export { hasUnseenWake };

export function isThreadAttentionShell(
  thread: ThreadAttentionShell & Pick<EnvironmentThreadShell, "snoozedUntil" | "snoozedAt">,
  options: { readonly now: string; readonly lastVisitedAt?: string | undefined },
): boolean {
  const status = resolveThreadListV2Status(thread);
  return isThreadAttention({
    isReady: status === "ready",
    readyAttentionSignal:
      hasPlanReadyPrompt(thread) || hasUnseenCompletion(thread, options.lastVisitedAt),
    wokeAt: threadWokeAt(thread, { now: options.now }),
    ...(options.lastVisitedAt === undefined ? {} : { lastVisitedAt: options.lastVisitedAt }),
  });
}

export interface ThreadAttentionFilterState {
  readonly memberThreadKeys: ReadonlySet<string>;
  readonly knownThreadKeys: ReadonlySet<string>;
  readonly memberPendingTaskKeys: ReadonlySet<string>;
  readonly knownPendingTaskKeys: ReadonlySet<string>;
}

type ThreadAttentionKeyInput = Pick<EnvironmentThreadShell, "environmentId" | "id">;

export function pendingTaskAttentionKey(input: {
  readonly environmentId: string;
  readonly messageId: string;
}): string {
  return `${input.environmentId}:${input.messageId}`;
}

export function createThreadAttentionFilter(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTaskKeys?: ReadonlyArray<string>;
  readonly now: string;
  readonly lastVisitedAtByThreadKey?: ReadonlyMap<string, string>;
}): ThreadAttentionFilterState {
  const initialMemberThreadKeys: string[] = [];
  const threadKeys: string[] = [];
  for (const thread of input.threads) {
    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
    threadKeys.push(threadKey);
    const lastVisitedAt = input.lastVisitedAtByThreadKey?.get(threadKey);
    if (
      thread.archivedAt === null &&
      isThreadAttentionShell(thread, {
        now: input.now,
        ...(lastVisitedAt === undefined ? {} : { lastVisitedAt }),
      })
    ) {
      initialMemberThreadKeys.push(threadKey);
    }
  }
  const state = createAttentionFilter({
    initialMemberKeys: initialMemberThreadKeys,
    keys: threadKeys,
  });
  const knownPendingTaskKeys = new Set(input.pendingTaskKeys ?? []);
  return {
    memberThreadKeys: state.memberKeys,
    knownThreadKeys: state.knownKeys,
    memberPendingTaskKeys: new Set(knownPendingTaskKeys),
    knownPendingTaskKeys,
  };
}

export function admitNewThreadAttentionThreads(
  state: ThreadAttentionFilterState,
  threads: ReadonlyArray<ThreadAttentionKeyInput>,
  pendingTaskKeys: ReadonlyArray<string> = [],
): ThreadAttentionFilterState {
  const threadState = admitNewAttentionKeys(
    { memberKeys: state.memberThreadKeys, knownKeys: state.knownThreadKeys },
    threads.map((thread) => scopedThreadKey(thread.environmentId, thread.id)),
  );
  const pendingTaskState = admitNewAttentionKeys(
    { memberKeys: state.memberPendingTaskKeys, knownKeys: state.knownPendingTaskKeys },
    pendingTaskKeys,
  );

  if (
    threadState.memberKeys === state.memberThreadKeys &&
    threadState.knownKeys === state.knownThreadKeys &&
    pendingTaskState.memberKeys === state.memberPendingTaskKeys &&
    pendingTaskState.knownKeys === state.knownPendingTaskKeys
  ) {
    return state;
  }
  return {
    memberThreadKeys: threadState.memberKeys,
    knownThreadKeys: threadState.knownKeys,
    memberPendingTaskKeys: pendingTaskState.memberKeys,
    knownPendingTaskKeys: pendingTaskState.knownKeys,
  };
}
