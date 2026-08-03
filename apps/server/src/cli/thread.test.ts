import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import {
  CliOrchestrationDeclaredResponseError,
  CliOrchestrationOutcomeUnknownError,
  CliOrchestrationRequestError,
} from "./orchestration.ts";
import {
  compensateFailedThreadStart,
  resolveThreadCliWorkspaceSelection,
  threadSummary,
} from "./thread.ts";

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

it.effect("finishes compensation when interrupted after cleanup starts", () =>
  Effect.gen(function* () {
    const cleanupStarted = yield* Deferred.make<void>();
    const releaseCleanup = yield* Deferred.make<void>();
    let cleanupFinished = false;
    const fiber = yield* compensateFailedThreadStart(
      rejectedStart,
      Effect.gen(function* () {
        yield* Deferred.succeed(cleanupStarted, undefined);
        yield* Deferred.await(releaseCleanup);
        cleanupFinished = true;
      }),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* Deferred.await(cleanupStarted);
    fiber.interruptUnsafe();
    yield* Deferred.succeed(releaseCleanup, undefined);
    yield* Fiber.await(fiber);

    assert.isTrue(cleanupFinished);
  }),
);

const workspaceFlags = (input: {
  newWorktree?: boolean;
  worktree?: string;
  branch?: string;
  base?: string;
  startFromOrigin?: boolean;
}) => ({
  newWorktree: input.newWorktree ?? false,
  worktree: Option.fromNullishOr(input.worktree),
  branch: Option.fromNullishOr(input.branch),
  base: Option.fromNullishOr(input.base),
  startFromOrigin: input.startFromOrigin ?? false,
});

it.effect("defaults to the current checkout without workspace flags", () =>
  Effect.gen(function* () {
    const selection = yield* resolveThreadCliWorkspaceSelection(workspaceFlags({}));
    assert.deepEqual(selection, { mode: "checkout" });
  }),
);

it.effect("resolves --new-worktree with base, branch, and origin options", () =>
  Effect.gen(function* () {
    const selection = yield* resolveThreadCliWorkspaceSelection(
      workspaceFlags({
        newWorktree: true,
        base: "main",
        branch: "t3code/feature",
        startFromOrigin: true,
      }),
    );
    assert.deepEqual(selection, {
      mode: "new-worktree",
      base: "main",
      branch: "t3code/feature",
      startFromOrigin: true,
    });
  }),
);

it.effect("resolves --worktree with an optional branch", () =>
  Effect.gen(function* () {
    const selection = yield* resolveThreadCliWorkspaceSelection(
      workspaceFlags({ worktree: "/tmp/worktrees/feature", branch: "t3code/feature" }),
    );
    assert.deepEqual(selection, {
      mode: "existing-worktree",
      worktreePath: "/tmp/worktrees/feature",
      branch: "t3code/feature",
    });
  }),
);

it.effect("rejects combining --new-worktree with --worktree", () =>
  Effect.gen(function* () {
    const error = yield* resolveThreadCliWorkspaceSelection(
      workspaceFlags({ newWorktree: true, worktree: "/tmp/worktrees/feature" }),
    ).pipe(Effect.flip);
    assert.equal(error._tag, "ThreadCliWorkspaceFlagError");
  }),
);

it.effect("rejects worktree-only options without their mode flag", () =>
  Effect.gen(function* () {
    const baseError = yield* resolveThreadCliWorkspaceSelection(
      workspaceFlags({ base: "main" }),
    ).pipe(Effect.flip);
    assert.include(baseError.detail, "--base");

    const originError = yield* resolveThreadCliWorkspaceSelection(
      workspaceFlags({ startFromOrigin: true }),
    ).pipe(Effect.flip);
    assert.include(originError.detail, "--start-from-origin");

    const branchError = yield* resolveThreadCliWorkspaceSelection(
      workspaceFlags({ branch: "t3code/feature" }),
    ).pipe(Effect.flip);
    assert.include(branchError.detail, "--branch");
  }),
);

it("includes branch and worktree path in thread summaries", () => {
  const summary = threadSummary(
    threadWith({
      branch: "t3code/feature",
      worktreePath: "/tmp/worktrees/feature",
    }),
  );

  assert.equal(summary.branch, "t3code/feature");
  assert.equal(summary.worktreePath, "/tmp/worktrees/feature");
});

it("normalizes missing branch and worktree path to null in thread summaries", () => {
  const summary = threadSummary(threadWith({}));

  assert.isNull(summary.branch);
  assert.isNull(summary.worktreePath);
});
