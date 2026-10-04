import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { CommandId, RunId, ThreadId } from "@t3tools/contracts";

import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

const failedAt = DateTime.makeUnsafe("2026-10-04T10:00:00.000Z");
const resetAt = "2026-10-04T11:00:00.000Z";
const nowMs = Date.parse("2026-10-04T12:00:00.000Z");
const runId = RunId.make("run-limited");

// An armed auto-resume past its reset time.
const armed: ProjectionLimitRecoveryCandidate = {
  id: ThreadId.make("thread-limited"),
  status: "failed",
  lastErrorClass: "usage_limit",
  latestRunId: runId,
  usageLimitResetAt: resetAt,
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  latestRunCompletedAt: failedAt,
  updatedAt: failedAt,
  limitRecovery: {
    runId,
    resetAt,
    autoResume: true,
    snooze: false,
    requestId: CommandId.make("limit-arm"),
  },
  snoozedUntil: null,
  snoozedAt: null,
};

describe("limitRecoveryCommand (fork: indefinite snooze)", () => {
  it("defers resume while an indefinite snooze set after the failure holds", () => {
    const snoozed = { ...armed, snoozedAt: DateTime.makeUnsafe("2026-10-04T10:30:00.000Z") };
    expect(limitRecoveryCommand(snoozed, true, nowMs)).toBeNull();
  });

  it("resumes once unsnoozed, or when the snooze predates the failure", () => {
    expect(limitRecoveryCommand(armed, true, nowMs)?.type).toBe("message.dispatch");
    const earlier = { ...armed, snoozedAt: DateTime.makeUnsafe("2026-10-04T09:00:00.000Z") };
    expect(limitRecoveryCommand(earlier, true, nowMs)?.type).toBe("message.dispatch");
  });
});
