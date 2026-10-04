import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

/** The CLI's turn state vocabulary (`thread list --state`, summary `state`). */
export const THREAD_CLI_STATES = ["idle", "running", "interrupted", "completed", "error"] as const;
export type ThreadCliState = (typeof THREAD_CLI_STATES)[number];

type ThreadStateShell = Pick<OrchestrationV2ThreadShell, "status" | "activeRunId">;

/** The thread's latest run, folded into the CLI's turn states. A queued or
    preparing run counts as running: the thread has work about to start. */
export const threadCliState = (thread: ThreadStateShell): ThreadCliState => {
  if (thread.activeRunId !== null) return "running";
  switch (thread.status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return "running";
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "completed":
    case "rolled_back":
      return "completed";
    case "idle":
      return "idle";
  }
};

/** Whether `thread interrupt` has a run to stop. */
export const threadHasActiveTurn = (thread: ThreadStateShell): boolean =>
  thread.activeRunId !== null;
