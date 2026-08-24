import {
  ProjectId,
  ProviderInstanceId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
  decideThreadCliWorkspace,
  renderThreadMessagesText,
  resolveThreadCliDefaultWorkspace,
  resolveThreadCliWorkspaceSelection,
  threadMessagesReport,
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
  checkout?: boolean;
  newWorktree?: boolean;
  worktree?: string;
  branch?: string;
  base?: string;
  startFromOrigin?: boolean;
}) => ({
  checkout: input.checkout ?? false,
  newWorktree: input.newWorktree ?? false,
  worktree: Option.fromNullishOr(input.worktree),
  branch: Option.fromNullishOr(input.branch),
  base: Option.fromNullishOr(input.base),
  startFromOrigin: input.startFromOrigin ?? false,
});

it.effect("selects the configured default without workspace flags", () =>
  Effect.gen(function* () {
    const selection = yield* resolveThreadCliWorkspaceSelection(workspaceFlags({}));
    assert.deepEqual(selection, { mode: "default" });
  }),
);

it.effect("resolves --checkout to the explicit checkout pick", () =>
  Effect.gen(function* () {
    const selection = yield* resolveThreadCliWorkspaceSelection(workspaceFlags({ checkout: true }));
    assert.deepEqual(selection, { mode: "checkout" });
  }),
);

it.effect("rejects combining --checkout with worktree flags", () =>
  Effect.gen(function* () {
    const newWorktreeError = yield* resolveThreadCliWorkspaceSelection(
      workspaceFlags({ checkout: true, newWorktree: true }),
    ).pipe(Effect.flip);
    assert.include(newWorktreeError.detail, "--checkout and --new-worktree");

    const worktreeError = yield* resolveThreadCliWorkspaceSelection(
      workspaceFlags({ checkout: true, worktree: "/tmp/worktrees/feature" }),
    ).pipe(Effect.flip);
    assert.include(worktreeError.detail, "--checkout and --worktree");

    const branchError = yield* resolveThreadCliWorkspaceSelection(
      workspaceFlags({ checkout: true, branch: "t3code/feature" }),
    ).pipe(Effect.flip);
    assert.include(branchError.detail, "--branch");

    const baseError = yield* resolveThreadCliWorkspaceSelection(
      workspaceFlags({ checkout: true, base: "main" }),
    ).pipe(Effect.flip);
    assert.include(baseError.detail, "--base");

    const originError = yield* resolveThreadCliWorkspaceSelection(
      workspaceFlags({ checkout: true, startFromOrigin: true }),
    ).pipe(Effect.flip);
    assert.include(originError.detail, "--start-from-origin");
  }),
);

it("decides the workspace against the server's bootstrap capability", () => {
  const newWorktree = {
    mode: "new-worktree",
    base: null,
    branch: null,
    startFromOrigin: false,
  } as const;
  const existingWorktree = {
    mode: "existing-worktree",
    worktreePath: "/tmp/worktrees/feature",
    branch: null,
  } as const;

  // Worktree modes proceed unchanged on a capable server.
  assert.deepEqual(
    decideThreadCliWorkspace({
      requested: newWorktree,
      fromDefaults: false,
      bootstrapSupported: true,
    }),
    { kind: "proceed", workspace: newWorktree },
  );
  assert.deepEqual(
    decideThreadCliWorkspace({
      requested: newWorktree,
      fromDefaults: true,
      bootstrapSupported: true,
    }),
    { kind: "proceed", workspace: newWorktree },
  );

  // Explicit --new-worktree fails hard without the capability.
  assert.deepEqual(
    decideThreadCliWorkspace({
      requested: newWorktree,
      fromDefaults: false,
      bootstrapSupported: false,
    }),
    { kind: "unsupported" },
  );

  // A defaults-derived worktree falls back to the checkout instead.
  assert.deepEqual(
    decideThreadCliWorkspace({
      requested: newWorktree,
      fromDefaults: true,
      bootstrapSupported: false,
    }),
    { kind: "fallback-checkout" },
  );

  // Checkout and existing worktrees never depend on the capability.
  assert.deepEqual(
    decideThreadCliWorkspace({
      requested: { mode: "checkout" },
      fromDefaults: true,
      bootstrapSupported: false,
    }),
    { kind: "proceed", workspace: { mode: "checkout" } },
  );
  assert.deepEqual(
    decideThreadCliWorkspace({
      requested: existingWorktree,
      fromDefaults: false,
      bootstrapSupported: false,
    }),
    { kind: "proceed", workspace: existingWorktree },
  );
});

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
      drainStale: false,
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

it.layer(NodeServices.layer)("thread default workspace resolution", (it) => {
  const makeWorkspace = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-thread-defaults-" });
    const workspaceRoot = path.join(dir, "project");
    yield* fs.makeDirectory(workspaceRoot, { recursive: true });
    const settingsPath = path.join(dir, "settings.json");
    const writeT3Json = (contents: string) =>
      fs.writeFileString(path.join(workspaceRoot, "t3.json"), contents);
    const writeSettings = (contents: string) => fs.writeFileString(settingsPath, contents);
    return { workspaceRoot, settingsPath, writeT3Json, writeSettings };
  });

  it.effect("defaults to the checkout when no source selects worktrees", () =>
    Effect.gen(function* () {
      const { workspaceRoot, settingsPath } = yield* makeWorkspace;
      const selection = yield* resolveThreadCliDefaultWorkspace({
        projectSetting: null,
        workspaceRoot,
        settingsPath,
      });
      assert.deepEqual(selection, { mode: "checkout" });
    }),
  );

  it.effect("honors a project worktree override with the origin default", () =>
    Effect.gen(function* () {
      const { workspaceRoot, settingsPath } = yield* makeWorkspace;
      const selection = yield* resolveThreadCliDefaultWorkspace({
        projectSetting: "worktree",
        workspaceRoot,
        settingsPath,
      });
      assert.deepEqual(selection, {
        mode: "new-worktree",
        base: null,
        branch: null,
        startFromOrigin: true,
      });
    }),
  );

  it.effect("lets a project local override beat t3.json and the global setting", () =>
    Effect.gen(function* () {
      const { workspaceRoot, settingsPath, writeT3Json, writeSettings } = yield* makeWorkspace;
      yield* writeT3Json('{ "defaultThreadEnvMode": "worktree" }');
      yield* writeSettings('{ "defaultThreadEnvMode": "worktree" }');
      const selection = yield* resolveThreadCliDefaultWorkspace({
        projectSetting: "local",
        workspaceRoot,
        settingsPath,
      });
      assert.deepEqual(selection, { mode: "checkout" });
    }),
  );

  it.effect("consults t3.json when the project has no override", () =>
    Effect.gen(function* () {
      const { workspaceRoot, settingsPath, writeT3Json, writeSettings } = yield* makeWorkspace;
      yield* writeT3Json('{ "defaultThreadEnvMode": "worktree" }');
      yield* writeSettings(
        '{ "defaultThreadEnvMode": "local", "newWorktreesStartFromOrigin": false }',
      );
      const selection = yield* resolveThreadCliDefaultWorkspace({
        projectSetting: null,
        workspaceRoot,
        settingsPath,
      });
      assert.deepEqual(selection, {
        mode: "new-worktree",
        base: null,
        branch: null,
        startFromOrigin: false,
      });
    }),
  );

  it.effect("falls back to the global setting when project and t3.json are silent", () =>
    Effect.gen(function* () {
      const { workspaceRoot, settingsPath, writeSettings } = yield* makeWorkspace;
      yield* writeSettings(
        '{ "defaultThreadEnvMode": "worktree", "newWorktreesStartFromOrigin": false }',
      );
      const selection = yield* resolveThreadCliDefaultWorkspace({
        projectSetting: undefined,
        workspaceRoot,
        settingsPath,
      });
      assert.deepEqual(selection, {
        mode: "new-worktree",
        base: null,
        branch: null,
        startFromOrigin: false,
      });
    }),
  );

  it.effect("treats malformed t3.json and settings.json as absent", () =>
    Effect.gen(function* () {
      const { workspaceRoot, settingsPath, writeT3Json, writeSettings } = yield* makeWorkspace;
      yield* writeT3Json("{ not json");
      yield* writeSettings("{ not json");
      const selection = yield* resolveThreadCliDefaultWorkspace({
        projectSetting: null,
        workspaceRoot,
        settingsPath,
      });
      assert.deepEqual(selection, { mode: "checkout" });
    }),
  );
});

describe("thread messages report", () => {
  const messageWith = (
    input: Partial<Record<keyof OrchestrationMessage, unknown>>,
  ): OrchestrationMessage =>
    ({
      id: "message-1",
      role: "assistant",
      text: "Hello",
      turnId: null,
      streaming: false,
      createdAt: "2026-08-20T10:00:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
      ...input,
    }) as OrchestrationMessage;

  const machine = {
    hostname: "spacemac",
    environmentId: "env-1",
    environmentLabel: "SpaceMac",
    platform: "darwin",
  };

  const reportWith = (input: Partial<Parameters<typeof threadMessagesReport>[0]>) =>
    threadMessagesReport({
      threadId: "thread-1",
      thread: threadWith({}),
      messages: [],
      hasMoreOlder: false,
      role: null,
      machine,
      attachmentsDir: "/data/attachments",
      attachmentFileExists: () => true,
      ...input,
    });

  it("excludes system messages by default and keeps user and assistant", () => {
    const report = reportWith({
      messages: [
        messageWith({ id: "m1", role: "system", text: "internal" }),
        messageWith({ id: "m2", role: "user", text: "question" }),
        messageWith({ id: "m3", role: "assistant", text: "answer" }),
      ],
    });

    assert.deepEqual(
      report.messages.map((message) => message.id),
      ["m2", "m3"],
    );
    assert.equal(report.archived, false);
    assert.equal(report.title, "Thread");
  });

  it("narrows to a single role when requested", () => {
    const report = reportWith({
      role: "assistant",
      messages: [
        messageWith({ id: "m1", role: "user" }),
        messageWith({ id: "m2", role: "assistant" }),
      ],
    });

    assert.deepEqual(
      report.messages.map((message) => message.id),
      ["m2"],
    );
  });

  it("marks threads outside the active shell as archived and pages from the unfiltered oldest message", () => {
    const report = reportWith({
      thread: null,
      hasMoreOlder: true,
      messages: [
        messageWith({ id: "m1", role: "system", text: "oldest, filtered out" }),
        messageWith({ id: "m2", role: "user" }),
      ],
    });

    assert.equal(report.archived, true);
    assert.isNull(report.title);
    assert.isNull(report.state);
    assert.equal(report.nextBefore, "m1");
  });

  it("resolves attachment paths against the attachments directory and reports missing files", () => {
    const report = reportWith({
      attachmentFileExists: (path) => path.endsWith("thread-1-present.png"),
      messages: [
        messageWith({
          id: "m1",
          role: "user",
          attachments: [
            {
              type: "image",
              id: "thread-1-present",
              name: "present.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
            {
              type: "image",
              id: "thread-1-missing",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 20,
            },
          ] as unknown as OrchestrationMessage["attachments"],
        }),
      ],
    });

    const attachments = report.messages[0]?.attachments ?? [];
    assert.equal(attachments[0]?.path, "/data/attachments/thread-1-present.png");
    assert.isTrue(attachments[0]?.exists);
    assert.equal(attachments[1]?.path, "/data/attachments/thread-1-missing.png");
    assert.isFalse(attachments[1]?.exists);

    const text = renderThreadMessagesText(report);
    assert.include(text, "-> /data/attachments/thread-1-missing.png [not found on this machine]");
    assert.include(text, "Attachment paths are local to spacemac.");
  });

  it("renders a transcript with machine identity and a paging hint", () => {
    const report = reportWith({
      hasMoreOlder: true,
      messages: [
        messageWith({ id: "m1", role: "user", text: "question" }),
        messageWith({ id: "m2", role: "assistant", text: "answer", streaming: true }),
      ],
    });

    const text = renderThreadMessagesText(report);
    assert.include(text, "Thread: Thread");
    assert.include(text, "Machine: spacemac (SpaceMac)");
    assert.include(text, "[user] 2026-08-20T10:00:00.000Z\nquestion");
    assert.include(text, "[assistant, streaming] 2026-08-20T10:00:00.000Z\nanswer");
    assert.include(text, "Rerun with --before m1");
  });
});
