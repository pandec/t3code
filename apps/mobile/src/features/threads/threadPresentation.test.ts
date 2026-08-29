import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadStatus } from "./threadPresentation";

const NOW = "2026-06-02T00:00:00.000Z";

function makeThread(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    ...input,
  };
}

const session = (status: "running" | "starting" | "error" | "ready") => ({
  threadId: ThreadId.make("thread-1"),
  status,
  providerName: "Codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: status === "error" ? "boom" : null,
  updatedAt: NOW,
});

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  assistantMessageId: null,
  requestedAt: "2026-06-01T09:00:00.000Z",
  startedAt: "2026-06-01T09:00:01.000Z",
  completedAt: "2026-06-01T09:05:00.000Z",
};

describe("resolveThreadStatus", () => {
  it("keeps blockers and foreground activity above background liveness", () => {
    expect(
      resolveThreadStatus(
        makeThread({
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          session: session("running"),
          backgroundLiveness: "monitoring",
        }),
      )?.kind,
    ).toBe("pending-approval");
    expect(
      resolveThreadStatus(
        makeThread({
          hasPendingUserInput: true,
          session: session("running"),
          backgroundLiveness: "monitoring",
        }),
      )?.kind,
    ).toBe("awaiting-input");
    expect(
      resolveThreadStatus(
        makeThread({ session: session("running"), backgroundLiveness: "monitoring" }),
      )?.kind,
    ).toBe("working");
    expect(
      resolveThreadStatus(
        makeThread({ session: session("starting"), backgroundLiveness: "monitoring" }),
      )?.kind,
    ).toBe("connecting");
    expect(
      resolveThreadStatus(makeThread({ session: session("error"), backgroundLiveness: "working" }))
        ?.kind,
    ).toBe("error");
  });

  it("keeps plan ready above background liveness", () => {
    expect(
      resolveThreadStatus(
        makeThread({
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: completedTurn,
          session: session("ready"),
          backgroundLiveness: "working",
        }),
      )?.kind,
    ).toBe("plan-ready");
  });

  it("presents background working and monitoring in the sky family", () => {
    expect(resolveThreadStatus(makeThread({ backgroundLiveness: "working" }))).toMatchObject({
      kind: "working",
      label: "Working",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-700-300",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: true,
    });
    expect(resolveThreadStatus(makeThread({ backgroundLiveness: "monitoring" }))).toMatchObject({
      kind: "monitoring",
      label: "Monitoring",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-700-300",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: false,
    });
  });

  it("returns no status for a quiescent thread", () => {
    expect(resolveThreadStatus(makeThread())).toBeNull();
  });
});
