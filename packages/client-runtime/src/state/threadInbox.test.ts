import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createInboxReturnTracker,
  isThreadWorking,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("isThreadWorking", () => {
  // Fork: a command left running after the turn keeps the thread working
  // until it exits, unless the run failed.
  const command = { taskId: "tests", kind: "command" as const };
  const settled = (status: "completed" | "failed") => ({
    ...thread("a", true),
    runtime: { ...thread("a", true).runtime!, status },
  });

  it("keeps a completed thread working while a command runs", () => {
    expect(isThreadWorking(settled("completed"))).toBe(false);
    expect(isThreadWorking({ ...settled("completed"), pendingBackgroundTasks: [command] })).toBe(
      true,
    );
    expect(isThreadWorking({ ...settled("failed"), pendingBackgroundTasks: [command] })).toBe(
      false,
    );
  });
});

describe("createInboxReturnTracker", () => {
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    const first = tracker.observe([thread("a", true), thread("b", false)]);
    expect(first(thread("a", true))).toBeUndefined();
    expect(first(thread("b", false))).toBeUndefined();

    const second = tracker.observe([thread("a", false), thread("b", false)]);
    expect(second(thread("a", false))).toBeDefined();
    expect(second(thread("b", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("a", false))).toBe(second(thread("a", false)));
    // An earlier observation keeps its answer, so lists built from it stay valid.
    expect(first(thread("a", false))).toBeUndefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});
