import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  MessageId,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

import { latestUnheldRun } from "@t3tools/shared/orchestrationV2ThreadError";

import { indefiniteSnoozeWokeByRun, isIndefinitelySnoozed } from "./IndefiniteSnooze.ts";

const SNOOZED_AT = DateTime.makeUnsafe("2026-10-04T10:00:00.000Z");
const before = DateTime.makeUnsafe("2026-10-04T09:00:00.000Z");
const after = DateTime.makeUnsafe("2026-10-04T11:00:00.000Z");

describe("isIndefinitelySnoozed", () => {
  it("is marked by snoozedAt without a wake time", () => {
    expect(isIndefinitelySnoozed({ snoozedUntil: null, snoozedAt: SNOOZED_AT })).toBe(true);
    expect(isIndefinitelySnoozed({ snoozedUntil: after, snoozedAt: SNOOZED_AT })).toBe(false);
    expect(isIndefinitelySnoozed({ snoozedUntil: null, snoozedAt: null })).toBe(false);
    // Fork: an awaited run makes it the "until it's done" snooze instead.
    expect(
      isIndefinitelySnoozed({
        snoozedUntil: null,
        snoozedAt: SNOOZED_AT,
        snoozedUntilRunId: RunId.make("run-1"),
      }),
    ).toBe(false);
  });
});

describe("indefiniteSnoozeWokeByRun", () => {
  const wokeByRun = (runs: ReadonlyArray<OrchestrationV2Run>) =>
    indefiniteSnoozeWokeByRun(runs, latestUnheldRun(runs), SNOOZED_AT);
  const run = (
    status: OrchestrationV2Run["status"],
    completedAt: DateTime.Utc | null,
    ordinal = 1,
    queueHeld?: boolean,
  ): OrchestrationV2Run => ({
    id: RunId.make(`run-${ordinal}`),
    threadId: ThreadId.make("thread-1"),
    ordinal,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: before,
    startedAt: null,
    completedAt,
    checkpointId: null,
    contextHandoffId: null,
    ...(queueHeld === undefined ? {} : { queueHeld }),
  });

  it("wakes on any run that ended after the snooze, not on live or earlier runs", () => {
    for (const status of ["completed", "interrupted", "failed"] as const) {
      expect(wokeByRun([run(status, after)])).toBe(true);
    }
    expect(wokeByRun([run("completed", before)])).toBe(false);
    expect(wokeByRun([run("running", null)])).toBe(false);
    expect(wokeByRun([run("cancelled", after)])).toBe(false);
  });

  // Fork: a queued message carries the work on, as clients see it.
  it("holds while queued messages wait, unless the queue is held or the run failed", () => {
    const queued = run("queued", null, 2);
    expect(wokeByRun([run("completed", after), queued])).toBe(false);
    expect(wokeByRun([run("completed", after), run("queued", null, 2, true)])).toBe(true);
    expect(wokeByRun([run("failed", after), queued])).toBe(true);
    // A queued message outranks a run that started ahead of it with a newer ordinal.
    expect(wokeByRun([run("queued", null, 1), run("completed", after, 2)])).toBe(false);
  });

  it("ignores a message cancelled before it started, as clients do", () => {
    expect(wokeByRun([run("completed", after), run("cancelled", after, 2)])).toBe(true);
  });
});
