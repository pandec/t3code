import type { RunId } from "@t3tools/contracts";

import { type EnvironmentThreadShell, threadRuntimeIsActive } from "./models.ts";

type ForkableThread = Pick<
  EnvironmentThreadShell,
  "archivedAt" | "deletedAt" | "lineage" | "latestRun" | "runtime"
>;

/**
 * The run a whole-conversation fork copies through: the thread's latest run,
 * once it has finished. The server forks natively where the provider supports
 * it and otherwise replays the transcript as portable context, so any provider
 * qualifies.
 *
 * Mirrors the server's `conversationForkSourceRun` (ThreadForkService), plus
 * the cases users hit from a thread list: archived and subagent threads, and
 * threads with live work (a fork taken mid-turn would silently leave out the
 * running turn). Threads that have no run yet, such as legacy history not
 * continued since the upgrade, have nothing to fork from.
 */
export function conversationForkRunId(thread: ForkableThread): RunId | null {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return null;
  if (thread.lineage.relationshipToParent === "subagent") return null;
  if (threadRuntimeIsActive(thread.runtime)) return null;
  const latestRun = thread.latestRun;
  if (latestRun === null) return null;
  switch (latestRun.status) {
    case "completed":
    case "failed":
    case "interrupted":
    case "cancelled":
      return latestRun.runId;
    default:
      return null;
  }
}

export function canForkConversation(thread: ForkableThread): boolean {
  return conversationForkRunId(thread) !== null;
}
