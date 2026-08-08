import {
  ProjectId,
  ProviderInstanceId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import {
  CliOrchestrationDeclaredResponseError,
  CliOrchestrationOutcomeUnknownError,
  CliOrchestrationRequestError,
} from "./orchestration.ts";
import {
  buildNewWorktreeBootstrap,
  compensateFailedThreadStart,
  resolveThreadCliWorkspaceSelection,
  threadSummary,
  threadWaitDrainFlag,
  threadWaitSummary,
} from "./thread.ts";
import type { WaitForThreadResult } from "./threadWait.ts";

const parseDrainFlag = (args: ReadonlyArray<string>) => {
  let parsed: "agents" | "all" | null | undefined;
  const command = Command.make("wait", { drain: threadWaitDrainFlag }).pipe(
    Command.withHandler(({ drain }) =>
      Effect.sync(() => {
        parsed = drain;
      }),
    ),
  );
  return Command.runWith(command, { version: "0.0.0" })(args).pipe(
    Effect.map(() => parsed),
    Effect.provide(NodeServices.layer),
  );
};

it.effect("parses every supported drain flag form", () =>
  Effect.gen(function* () {
    assert.isNull(yield* parseDrainFlag([]));
    assert.strictEqual(yield* parseDrainFlag(["--drain"]), "agents");
    assert.strictEqual(yield* parseDrainFlag(["--drain=agents"]), "agents");
    assert.strictEqual(yield* parseDrainFlag(["--drain=all"]), "all");
  }),
);

it.effect("rejects the unsupported space-separated drain value", () =>
  Effect.gen(function* () {
    const error = yield* parseDrainFlag(["--drain", "agents"]).pipe(Effect.flip);
    assert.isTrue(CliError.isCliError(error));
    assert.strictEqual(error._tag, "ShowHelp");
    if (error._tag === "ShowHelp") {
      assert.strictEqual(error.errors[0]?._tag, "UnexpectedArgument");
    }
  }),
);

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

it("includes background liveness in thread summaries", () => {
  assert.strictEqual(
    threadSummary(threadWith({ backgroundLiveness: "working" })).backgroundLiveness,
    "working",
  );
  assert.isNull(threadSummary(threadWith({ backgroundLiveness: undefined })).backgroundLiveness);
});

it("builds the wait JSON result with diagnostics and turn timestamps", () => {
  const thread = threadWith({
    backgroundLiveness: "working",
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "running",
      requestedAt: "2026-08-08T11:59:00.000Z",
      startedAt: "2026-08-08T11:59:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    } as OrchestrationThreadShell["latestTurn"],
  });
  const summary = threadWaitSummary({
    evaluation: {
      status: "terminal",
      outcome: "timeout",
      adoptionTimedOut: false,
      drainUnsupported: false,
    },
    thread,
    snapshot: { snapshotSequence: 42 } as OrchestrationShellSnapshot,
    waited: true,
    waitedMs: 5_000,
  } satisfies WaitForThreadResult);

  assert.strictEqual(summary.outcome, "timeout");
  assert.isTrue(summary.waited);
  assert.strictEqual(summary.waitedMs, 5_000);
  assert.strictEqual(summary.observedSequence, 42);
  assert.isFalse(summary.adoptionTimedOut);
  assert.strictEqual(summary.state, "running");
  assert.strictEqual(summary.backgroundLiveness, "working");
  assert.deepEqual(summary.turn, {
    turnId: TurnId.make("turn-1"),
    state: "running",
    requestedAt: "2026-08-08T11:59:00.000Z",
    startedAt: "2026-08-08T11:59:01.000Z",
    completedAt: null,
  });
});

const newWorktreeSelection = (input: {
  base?: string | null;
  branch?: string | null;
  startFromOrigin?: boolean;
}) =>
  ({
    mode: "new-worktree",
    base: input.base ?? null,
    branch: input.branch ?? null,
    startFromOrigin: input.startFromOrigin ?? false,
  }) as const;

const bootstrapInput = (workspace: ReturnType<typeof newWorktreeSelection>) => ({
  project: { id: ProjectId.make("project-1"), workspaceRoot: "/tmp/project" },
  title: "Start working",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  workspace,
  worktreeBranch: "t3code/feature",
  createdAt: "2026-08-03T00:00:00.000Z",
});

it("omits baseBranch and startFromOrigin from the bootstrap when not requested", () => {
  const bootstrap = buildNewWorktreeBootstrap(bootstrapInput(newWorktreeSelection({})));

  assert.deepEqual(bootstrap.prepareWorktree, {
    projectCwd: "/tmp/project",
    branch: "t3code/feature",
  });
  assert.isTrue(bootstrap.runSetupScript);
  assert.isNull(bootstrap.createThread?.branch);
  assert.isNull(bootstrap.createThread?.worktreePath);
});

it("includes baseBranch and startFromOrigin in the bootstrap when requested", () => {
  const bootstrap = buildNewWorktreeBootstrap(
    bootstrapInput(newWorktreeSelection({ base: "main", startFromOrigin: true })),
  );

  assert.deepEqual(bootstrap.prepareWorktree, {
    projectCwd: "/tmp/project",
    baseBranch: "main",
    branch: "t3code/feature",
    startFromOrigin: true,
  });
});
