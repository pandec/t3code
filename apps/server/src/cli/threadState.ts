import type { OrchestrationThreadShell } from "@t3tools/contracts";

export const threadCliState = (thread: OrchestrationThreadShell) => {
  if (thread.session?.status === "error") return "error";
  if (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running"
  ) {
    return "running";
  }
  return thread.latestTurn?.state ?? "idle";
};

export const threadHasActiveTurn = (thread: OrchestrationThreadShell): boolean => {
  if (thread.session?.status === "starting" || thread.session?.status === "error") {
    return false;
  }
  return (
    thread.latestTurn?.state === "running" ||
    (thread.session?.status === "running" && thread.session.activeTurnId !== null)
  );
};
