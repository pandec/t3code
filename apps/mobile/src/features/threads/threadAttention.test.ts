import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  admitNewThreadAttentionThreads,
  createThreadAttentionFilter,
  hasUnseenCompletion,
  hasUnseenWake,
  isThreadAttentionShell,
} from "./threadAttention";

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-02T00:00:00.000Z";

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId: ProjectId.make("project-1"),
    title: String(input.id),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

function completedTurn() {
  return {
    turnId: TurnId.make("turn-1"),
    state: "completed" as const,
    assistantMessageId: null,
    requestedAt: "2026-06-01T09:00:00.000Z",
    startedAt: "2026-06-01T09:00:01.000Z",
    completedAt: "2026-06-01T09:05:00.000Z",
  };
}

function runningSession(status: "running" | "starting" | "error") {
  return {
    threadId: ThreadId.make("thread"),
    status,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: status === "error" ? "boom" : null,
    updatedAt: NOW,
  };
}

describe("mobile thread attention filter", () => {
  it("recognizes every desktop attention status", () => {
    const ready = makeThread({ id: ThreadId.make("ready") });

    expect(isThreadAttentionShell({ ...ready, hasPendingApprovals: true }, { now: NOW })).toBe(
      true,
    );
    expect(isThreadAttentionShell({ ...ready, hasPendingUserInput: true }, { now: NOW })).toBe(
      true,
    );
    expect(
      isThreadAttentionShell({ ...ready, session: runningSession("running") }, { now: NOW }),
    ).toBe(true);
    expect(
      isThreadAttentionShell({ ...ready, session: runningSession("starting") }, { now: NOW }),
    ).toBe(true);
    expect(
      isThreadAttentionShell({ ...ready, session: runningSession("error") }, { now: NOW }),
    ).toBe(true);
    expect(
      isThreadAttentionShell(
        {
          ...ready,
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: completedTurn(),
        },
        { now: NOW },
      ),
    ).toBe(true);
    expect(
      isThreadAttentionShell(
        { ...ready, latestTurn: completedTurn() },
        { now: NOW, lastVisitedAt: "2026-06-01T09:04:00.000Z" },
      ),
    ).toBe(true);
    expect(
      isThreadAttentionShell(
        {
          ...ready,
          snoozedAt: "2026-06-01T08:00:00.000Z",
          snoozedUntil: "2026-06-01T09:00:00.000Z",
        },
        { now: NOW },
      ),
    ).toBe(true);
  });

  it("keeps a fully visited ready thread out", () => {
    const ready = makeThread({
      id: ThreadId.make("ready"),
      latestTurn: completedTurn(),
      snoozedAt: "2026-06-01T08:00:00.000Z",
      snoozedUntil: "2026-06-01T09:00:00.000Z",
    });

    expect(
      isThreadAttentionShell(ready, {
        now: NOW,
        lastVisitedAt: "2026-06-01T10:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("matches desktop unseen completion and wake edge cases", () => {
    expect(hasUnseenCompletion({ latestTurn: completedTurn() }, "2026-06-01T09:04:00.000Z")).toBe(
      true,
    );
    expect(hasUnseenCompletion({ latestTurn: completedTurn() }, undefined)).toBe(false);
    expect(hasUnseenWake({ wokeAt: null })).toBe(false);
    expect(hasUnseenWake({ wokeAt: "not-a-date" })).toBe(false);
    expect(hasUnseenWake({ wokeAt: "2026-06-01T09:00:00.000Z" })).toBe(true);
  });

  it("captures members, keeps them sticky, and admits newly appearing shells", () => {
    const working = makeThread({
      id: ThreadId.make("working"),
      session: runningSession("running"),
    });
    const ready = makeThread({ id: ThreadId.make("ready") });
    const state = createThreadAttentionFilter({
      threads: [working, ready],
      pendingTaskKeys: ["queued-before"],
      now: NOW,
    });

    expect(state.memberThreadKeys).toEqual(new Set(["environment-1:working"]));
    expect(state.knownThreadKeys).toEqual(
      new Set(["environment-1:working", "environment-1:ready"]),
    );
    expect(state.memberPendingTaskKeys).toEqual(new Set(["queued-before"]));
    expect(state.knownPendingTaskKeys).toEqual(new Set(["queued-before"]));
    expect(admitNewThreadAttentionThreads(state, [working, ready], ["queued-before"])).toBe(state);

    const next = admitNewThreadAttentionThreads(
      state,
      [working, ready, makeThread({ id: ThreadId.make("created-elsewhere") })],
      ["queued-before", "queued-after"],
    );
    expect(next.memberThreadKeys).toEqual(
      new Set(["environment-1:working", "environment-1:created-elsewhere"]),
    );
    expect(next.knownThreadKeys).toContain("environment-1:created-elsewhere");
    expect(next.memberPendingTaskKeys).toEqual(new Set(["queued-before", "queued-after"]));
    expect(next.knownPendingTaskKeys).toEqual(new Set(["queued-before", "queued-after"]));
  });
});
