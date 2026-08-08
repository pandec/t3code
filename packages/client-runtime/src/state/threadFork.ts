import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { isThreadForkFailure } from "@t3tools/shared/conversationFork";

/**
 * Forking replays a persisted provider conversation: only the providers that
 * support it, only while nothing is mid-turn, and never from a thread whose
 * own fork already failed.
 *
 * This hides the action in the cases users actually hit. It is not a complete
 * mirror of the server's fork invariants, which additionally reject archived
 * threads and sessions with no persisted provider instance — so a fork offered
 * here can still be refused. The server enforces its own version regardless,
 * naming the failing clause.
 */
export function canForkConversation(
  thread: Pick<OrchestrationThreadShell, "latestTurn" | "session">,
): boolean {
  const session = thread.session;
  return (
    (session?.providerName === "codex" || session?.providerName === "claudeAgent") &&
    session.status !== "starting" &&
    session.status !== "running" &&
    session.status !== "error" &&
    session.activeTurnId === null &&
    thread.latestTurn?.state !== "running" &&
    !isThreadForkFailure(session.lastError)
  );
}
