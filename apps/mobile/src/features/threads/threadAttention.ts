import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { isLatestTurnSettled } from "./threadPresentation";
import { resolveThreadListV2Status } from "./threadListV2";

/**
 * Sticky "needs attention" filter, ported from the web sidebar v2
 * (apps/web/src/components/Sidebar.logic.ts: isSidebarV2AttentionThread and
 * the SidebarV2AttentionFilterState helpers), same as the rest of the Thread
 * List v2 model in threadListV2.ts.
 *
 * Like web, mobile persists device-local per-thread visit markers and compares
 * them with completion and wake timestamps.
 */

export type ThreadAttentionShell = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
  | "snoozedUntil"
  | "snoozedAt"
>;

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

export function hasUnseenWake(input: {
  wokeAt: string | null;
  lastVisitedAt?: string | undefined;
}): boolean {
  if (input.wokeAt === null) return false;
  const wokeAt = Date.parse(input.wokeAt);
  if (Number.isNaN(wokeAt)) return false;
  if (input.lastVisitedAt === undefined) return true;

  const lastVisitedAt = Date.parse(input.lastVisitedAt);
  return Number.isNaN(lastVisitedAt) || wokeAt > lastVisitedAt;
}

export function isThreadAttentionShell(
  thread: ThreadAttentionShell,
  options: { readonly now: string; readonly lastVisitedAt?: string | undefined },
): boolean {
  return (
    resolveThreadListV2Status(thread) !== "ready" ||
    hasPlanReadyPrompt(thread) ||
    hasUnseenCompletion(thread, options.lastVisitedAt) ||
    hasUnseenWake({
      wokeAt: threadWokeAt(thread, { now: options.now }),
      ...(options.lastVisitedAt === undefined ? {} : { lastVisitedAt: options.lastVisitedAt }),
    })
  );
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

/**
 * Snapshots current attention membership. Membership is sticky: a member
 * stays visible while the filter is on even after its status clears, so the
 * list never yanks a row out from under the user; toggling off and back on
 * takes a fresh snapshot.
 */
export function createThreadAttentionFilter(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTaskKeys?: ReadonlyArray<string>;
  readonly now: string;
  readonly lastVisitedAtByThreadKey?: ReadonlyMap<string, string>;
}): ThreadAttentionFilterState {
  const memberThreadKeys = new Set<string>();
  const knownThreadKeys = new Set<string>();
  const knownPendingTaskKeys = new Set(input.pendingTaskKeys ?? []);
  for (const thread of input.threads) {
    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
    knownThreadKeys.add(threadKey);
    if (thread.archivedAt !== null) continue;
    const lastVisitedAt = input.lastVisitedAtByThreadKey?.get(threadKey);
    if (
      isThreadAttentionShell(thread, {
        now: input.now,
        ...(lastVisitedAt === undefined ? {} : { lastVisitedAt }),
      })
    ) {
      memberThreadKeys.add(threadKey);
    }
  }
  return {
    memberThreadKeys,
    knownThreadKeys,
    memberPendingTaskKeys: new Set(),
    knownPendingTaskKeys,
  };
}

export function admitNewThreadAttentionThreads(
  state: ThreadAttentionFilterState,
  threads: ReadonlyArray<ThreadAttentionKeyInput>,
  pendingTaskKeys: ReadonlyArray<string> = [],
): ThreadAttentionFilterState {
  let knownThreadKeys: Set<string> | null = null;
  let memberThreadKeys: Set<string> | null = null;
  let knownPendingTaskKeys: Set<string> | null = null;
  let memberPendingTaskKeys: Set<string> | null = null;

  for (const thread of threads) {
    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
    if (state.knownThreadKeys.has(threadKey)) continue;

    knownThreadKeys ??= new Set(state.knownThreadKeys);
    memberThreadKeys ??= new Set(state.memberThreadKeys);
    knownThreadKeys.add(threadKey);
    // Admission is based on first appearance after the captured baseline, not
    // createdAt: connected environments have independent clocks, so comparing
    // their timestamps with the device clock can reject a genuine new thread.
    memberThreadKeys.add(threadKey);
  }

  for (const pendingTaskKey of pendingTaskKeys) {
    if (state.knownPendingTaskKeys.has(pendingTaskKey)) continue;
    knownPendingTaskKeys ??= new Set(state.knownPendingTaskKeys);
    memberPendingTaskKeys ??= new Set(state.memberPendingTaskKeys);
    knownPendingTaskKeys.add(pendingTaskKey);
    memberPendingTaskKeys.add(pendingTaskKey);
  }

  if (
    knownThreadKeys === null &&
    memberThreadKeys === null &&
    knownPendingTaskKeys === null &&
    memberPendingTaskKeys === null
  ) {
    return state;
  }
  return {
    knownThreadKeys: knownThreadKeys ?? state.knownThreadKeys,
    memberThreadKeys: memberThreadKeys ?? state.memberThreadKeys,
    knownPendingTaskKeys: knownPendingTaskKeys ?? state.knownPendingTaskKeys,
    memberPendingTaskKeys: memberPendingTaskKeys ?? state.memberPendingTaskKeys,
  };
}
