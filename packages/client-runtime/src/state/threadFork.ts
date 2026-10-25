import type { ProviderInstanceId, RunId, ServerProvider } from "@t3tools/contracts";

import { type EnvironmentThreadShell, threadRuntimeIsActive } from "./models.ts";

type ForkableThread = Pick<
  EnvironmentThreadShell,
  "archivedAt" | "deletedAt" | "lineage" | "latestRun" | "runtime" | "activeProviderThreadId"
>;

/**
 * - `run`: fork through that finished run (natively, or by replaying the transcript), so any
 *   provider qualifies.
 * - `imported-session`: a runless thread continuing an imported native session; forked with the
 *   session-import `forkThread` command.
 */
export type ConversationForkTarget =
  | { readonly type: "run"; readonly runId: RunId }
  | { readonly type: "imported-session" };

export interface ConversationForkOptions {
  /**
   * The thread's provider can fork a native session before its first turn;
   * resolve it with {@link canForkImportedSessionWith}. Defaults to false, so
   * an unknown provider hides the action rather than offering one that fails.
   */
  readonly canForkImportedSession?: boolean;
}

/** Driver kinds whose instances fork imported native sessions (server `sessionImport.forkSession`). */
export const importedSessionForkDrivers: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

export function canForkImportedSessionDriver(driver: string | undefined): boolean {
  return driver !== undefined && importedSessionForkDrivers.has(driver);
}

/** Whether `providerInstanceId` is, in the environment's provider list, a driver that forks imported sessions. */
export function canForkImportedSessionWith(
  providerInstanceId: ProviderInstanceId,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">> | undefined,
): boolean {
  return canForkImportedSessionDriver(
    providers?.find((provider) => provider.instanceId === providerInstanceId)?.driver,
  );
}

/**
 * The single fork-eligibility rule for web, mobile and the CLI. Archived, subagent and live
 * threads never fork (a mid-turn fork would omit the running turn). A runless thread forks only
 * from an imported native session its provider can fork; migrated legacy history cannot.
 */
export function conversationForkTarget(
  thread: ForkableThread,
  options?: ConversationForkOptions,
): ConversationForkTarget | null {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return null;
  if (thread.lineage.relationshipToParent === "subagent") return null;
  if (threadRuntimeIsActive(thread.runtime)) return null;
  const latestRun = thread.latestRun;
  if (latestRun === null) {
    return thread.activeProviderThreadId !== null && options?.canForkImportedSession === true
      ? { type: "imported-session" }
      : null;
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
export function conversationForkRunId(
  thread: ForkableThread,
  options?: ConversationForkOptions,
): RunId | null {
  const target = conversationForkTarget(thread, options);
  return target?.type === "run" ? target.runId : null;
}

export function canForkConversation(
  thread: ForkableThread,
  options?: ConversationForkOptions,
): boolean {
  return conversationForkTarget(thread, options) !== null;
}
