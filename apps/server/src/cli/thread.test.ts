import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  CliOrchestrationDeclaredResponseError,
  CliOrchestrationOutcomeUnknownError,
  CliOrchestrationRequestError,
} from "./orchestration.ts";
import { compensateFailedThreadStart, threadSummary } from "./thread.ts";

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

const rejectedStart = new CliOrchestrationDeclaredResponseError({
  operation: "callLiveServer",
  code: "THREAD_START_REJECTED",
  traceId: "trace-1",
  cause: new Error("rejected"),
});

it.effect("preserves the rejected start error when compensation succeeds", () =>
  Effect.gen(function* () {
    const error = yield* compensateFailedThreadStart(rejectedStart, Effect.void).pipe(Effect.flip);

    assert.strictEqual(error, rejectedStart);
  }),
);

it.effect("marks the command outcome unknown when compensation fails", () =>
  Effect.gen(function* () {
    const cleanupFailure = new CliOrchestrationRequestError({
      operation: "callLiveServer",
      cause: new Error("cleanup acknowledgement lost"),
    });
    const error = yield* compensateFailedThreadStart(
      rejectedStart,
      Effect.fail(cleanupFailure),
    ).pipe(Effect.flip);

    assert.instanceOf(error, CliOrchestrationOutcomeUnknownError);
  }),
);
