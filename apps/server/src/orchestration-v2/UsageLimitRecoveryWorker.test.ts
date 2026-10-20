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

describe("limitRecoveryCommand (fork)", () => {
  it("resumes past a stored snooze marker without a wake time", () => {
    expect(limitRecoveryCommand(armed, true, nowMs)?.type).toBe("message.dispatch");
    const legacy = { ...armed, snoozedAt: DateTime.makeUnsafe("2026-10-04T10:30:00.000Z") };
    expect(limitRecoveryCommand(legacy, true, nowMs)?.type).toBe("message.dispatch");
  });
});
