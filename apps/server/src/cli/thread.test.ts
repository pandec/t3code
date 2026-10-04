import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
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
  compensateFailedThreadStart,
  decodeThreadInputAnswersJson,
  resolveThreadCliDefaultWorkspace,
  resolveThreadCliWorkspaceSelection,
  threadWaitDrainFlag,
} from "./thread.ts";

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

  it.effect("uses live effective settings instead of the local settings file", () =>
    Effect.gen(function* () {
      const { workspaceRoot, settingsPath, writeSettings } = yield* makeWorkspace;
      yield* writeSettings(
        '{ "defaultThreadEnvMode": "local", "newWorktreesStartFromOrigin": true }',
      );
      const selection = yield* resolveThreadCliDefaultWorkspace({
        projectSetting: "worktree",
        workspaceRoot,
        settingsPath,
        settings: { ...DEFAULT_SERVER_SETTINGS, newWorktreesStartFromOrigin: false },
      });
      assert.deepEqual(selection, {
        mode: "new-worktree",
        base: null,
        branch: null,
        startFromOrigin: false,
      });
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

  it.effect("lets the environment setting beat t3.json", () =>
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
      assert.deepEqual(selection, { mode: "checkout" });
    }),
  );

  it.effect("inherits from t3.json when the environment setting is null", () =>
    Effect.gen(function* () {
      const { workspaceRoot, settingsPath, writeT3Json, writeSettings } = yield* makeWorkspace;
      yield* writeT3Json('{ "defaultThreadEnvMode": "worktree" }');
      yield* writeSettings(
        '{ "defaultThreadEnvMode": null, "newWorktreesStartFromOrigin": false }',
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

describe("thread input", () => {
  it.effect("rejects malformed answers JSON before dispatch", () =>
    Effect.gen(function* () {
      const error = yield* decodeThreadInputAnswersJson("not-json").pipe(Effect.flip);
      assert.isDefined(error);
    }),
  );
});
