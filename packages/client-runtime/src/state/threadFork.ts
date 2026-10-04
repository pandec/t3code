import type { RunId } from "@t3tools/contracts";

import { type EnvironmentThreadShell, threadRuntimeIsActive } from "./models.ts";

type ForkableThread = Pick<
  EnvironmentThreadShell,
  "archivedAt" | "deletedAt" | "lineage" | "latestRun" | "runtime" | "activeProviderThreadId"
>;

/**
 * How a whole-conversation fork is created:
 * - `run`: dispatch `thread.fork` through that finished run. The server forks
 *   natively where the provider supports it and otherwise replays the
 *   transcript as portable context, so any provider qualifies.
 * - `imported-session`: the thread continues an imported native session and
 *   has no run yet; fork it with the session-import `forkThread` command,
 *   which forks that native session.
 */
export type ConversationForkTarget =
  | { readonly type: "run"; readonly runId: RunId }
  | { readonly type: "imported-session" };

/**
 * The single fork-eligibility rule shared by web, mobile and the CLI (import
 * it from `@t3tools/client-runtime/state/thread-fork`). Archived and subagent
 * threads never fork, nor do threads with live work: a fork taken mid-turn
 * would silently leave out the running turn. A runless thread forks only when
 * it holds an imported native session; legacy history migrated at the v2
 * upgrade has no provider thread and nothing to fork from until its first
 * turn.
 */
export function conversationForkTarget(thread: ForkableThread): ConversationForkTarget | null {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return null;
  if (thread.lineage.relationshipToParent === "subagent") return null;
  if (threadRuntimeIsActive(thread.runtime)) return null;
  const latestRun = thread.latestRun;
  if (latestRun === null) {
    return thread.activeProviderThreadId === null ? null : { type: "imported-session" };
  }
  switch (latestRun.status) {
    case "completed":
    case "failed":
    case "interrupted":
    case "cancelled":
      return { type: "run", runId: latestRun.runId };
    default:
      return null;
  }
}

/** The run a run-based fork copies through, or null (see {@link conversationForkTarget}). */
export function conversationForkRunId(thread: ForkableThread): RunId | null {
  const target = conversationForkTarget(thread);
  return target?.type === "run" ? target.runId : null;
}

export function canForkConversation(thread: ForkableThread): boolean {
  return conversationForkTarget(thread) !== null;
}
