import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { isThreadForkFailure } from "@t3tools/shared/conversationFork";

/**
 * Forking replays a persisted provider conversation: only the providers that
 * support it, only while nothing is mid-turn, and never from a thread whose
 * own fork already failed. Client-side twin of the server's fork invariants
 * so a client never offers a fork the server then rejects — the server keeps
 * enforcing its own version, which names the failing clause.
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
