import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { threadSummary } from "./thread.ts";

const threadWith = (input: Partial<OrchestrationThreadShell>): OrchestrationThreadShell =>
  ({
    id: "thread-1",
    projectId: "project-1",
    title: "Thread",
    session: null,
    latestTurn: null,
    snoozedUntil: undefined,
    snoozedAt: undefined,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestUserMessageAt: null,
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...input,
  }) as OrchestrationThreadShell;

it("includes snooze timestamps in thread summaries", () => {
  const summary = threadSummary(
    threadWith({
      snoozedUntil: "2026-07-26T09:00:00.000Z",
      snoozedAt: "2026-07-25T09:00:00.000Z",
    }),
  );

  assert.equal(summary.snoozedUntil, "2026-07-26T09:00:00.000Z");
  assert.equal(summary.snoozedAt, "2026-07-25T09:00:00.000Z");
});

it("normalizes missing legacy snooze timestamps to null", () => {
  const summary = threadSummary(threadWith({}));

  assert.isNull(summary.snoozedUntil);
  assert.isNull(summary.snoozedAt);
});
