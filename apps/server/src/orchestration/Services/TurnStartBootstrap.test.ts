import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  ProviderInstanceId,
  ThreadId,
  ProjectId,
} from "@t3tools/contracts";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./OrchestrationEngine.ts";
import * as TurnStartBootstrap from "./TurnStartBootstrap.ts";

type TurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
type DispatchOptions = Parameters<OrchestrationEngine.OrchestrationEngineShape["dispatch"]>[1];

const threadId = ThreadId.make("thread-bootstrap-test");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const makeTurnStartCommand = (bootstrap: TurnStartCommand["bootstrap"]): TurnStartCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make("command-turn-start"),
  threadId,
  message: {
    messageId: MessageId.make("message-1"),
    role: "user",
    text: "Start working",
    attachments: [],
  },
  modelSelection,
  titleSeed: "Start working",
  runtimeMode: "full-access",
  interactionMode: "default",
  bootstrap,
  createdAt: "2026-08-03T00:00:00.000Z",
});

const createThreadBootstrap = {
  projectId: ProjectId.make("project-1"),
  title: "Start working",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: "2026-08-03T00:00:00.000Z",
} as const;

const testCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const localStatusWithRef = (refName: string | null) =>
  Effect.succeed({
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  });

const makeLayer = (input: {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly dispatchOptions?: Array<DispatchOptions>;
  readonly gitWorkflow?: Partial<GitWorkflowService.GitWorkflowService["Service"]>;
  readonly projectSetupScriptRunner?: Partial<
    ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]
  >;
  readonly failTurnStart?: boolean;
  readonly failThreadDelete?: boolean;
}) =>
  TurnStartBootstrap.layer.pipe(
    Layer.provide(
      Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
        dispatch: (command, options) => {
          input.dispatched.push(command);
          input.dispatchOptions?.push(options);
          if (input.failThreadDelete && command.type === "thread.delete") {
            return Effect.die(new Error("thread cleanup exploded"));
          }
          return input.failTurnStart && command.type === "thread.turn.start"
            ? Effect.die(new Error("turn start rejected"))
            : Effect.succeed({ sequence: input.dispatched.length });
        },
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () => localStatusWithRef("dev"),
        createWorktree: (request) =>
          Effect.succeed({
            worktree: {
              path: `/tmp/worktrees/${request.newRefName ?? request.refName}`,
              refName: request.newRefName ?? request.refName,
            },
          }),
        ...input.gitWorkflow,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
        ...input.projectSetupScriptRunner,
      }),
    ),
    Layer.provide(
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
        refreshStatus: () => Effect.die("refreshStatus is forked and ignored in these tests"),
      }),
    ),
    Layer.provide(testCryptoLayer),
  );

describe("TurnStartBootstrap", () => {
  it.effect("creates the thread, prepares the worktree, then starts the turn", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const dispatchOptions: Array<DispatchOptions> = [];
      const clientOptions = {
        origin: { surface: "mobile", appVersion: "1.2.3" },
      } as const;
      const result = yield* Effect.gen(function* () {
        const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
        return yield* bootstrap.dispatchTurnStart(
          makeTurnStartCommand({
            createThread: createThreadBootstrap,
            prepareWorktree: {
              projectCwd: "/tmp/project",
              baseBranch: "main",
              branch: "t3code/test-branch",
            },
            runSetupScript: true,
          }),
          clientOptions,
        );
      }).pipe(Effect.provide(makeLayer({ dispatched, dispatchOptions })));

      assert.deepEqual(
        dispatched.map((command) => command.type),
        ["thread.create", "thread.meta.update", "thread.turn.start"],
      );
      assert.deepEqual(dispatchOptions, [clientOptions, clientOptions, clientOptions]);
      const metaUpdate = dispatched[1] as Extract<
        OrchestrationCommand,
        { type: "thread.meta.update" }
      >;
      assert.equal(metaUpdate.branch, "t3code/test-branch");
      assert.equal(metaUpdate.worktreePath, "/tmp/worktrees/t3code/test-branch");
      const turnStart = dispatched[2] as TurnStartCommand;
      assert.isUndefined(turnStart.bootstrap);
      assert.equal(result.sequence, dispatched.length);
    }),
  );

  it.effect("passes client origin through setup activity and cleanup dispatches", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const dispatchOptions: Array<DispatchOptions> = [];
      const clientOptions = {
        origin: { surface: "desktop", appVersion: "2.0.0" },
      } as const;

      const result = yield* Effect.gen(function* () {
        const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
        return yield* bootstrap.dispatchTurnStart(
          makeTurnStartCommand({
            createThread: createThreadBootstrap,
            prepareWorktree: {
              projectCwd: "/tmp/project",
              baseBranch: "main",
              branch: "t3code/test-branch",
            },
            runSetupScript: true,
          }),
          clientOptions,
        );
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatched,
            dispatchOptions,
            failTurnStart: true,
            projectSetupScriptRunner: {
              runForThread: () =>
                Effect.succeed({
                  status: "started" as const,
                  scriptId: "script-1",
                  scriptName: "Setup",
                  terminalId: "terminal-1",
                  cwd: "/tmp/worktrees/t3code/test-branch",
                }),
            },
          }),
        ),
        Effect.flip,
      );

      assert.equal(result._tag, "OrchestrationDispatchCommandError");
      assert.equal(dispatched.length, 6);
      assert.deepEqual(
        dispatched
          .filter((command) => command.type === "thread.activity.append")
          .map((command) => command.activity.kind)
          .sort(),
        ["setup-script.requested", "setup-script.started"],
      );
      assert.equal(dispatchOptions.length, dispatched.length);
      assert.isTrue(dispatchOptions.every((options) => options === clientOptions));
    }),
  );

  it.effect("defaults the worktree base to the project's current branch", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const createWorktreeRequests: Array<{
        refName: string;
        newRefName: string | undefined;
        baseRefName: string | undefined;
      }> = [];
      yield* Effect.gen(function* () {
        const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
        return yield* bootstrap.dispatchTurnStart(
          makeTurnStartCommand({
            createThread: createThreadBootstrap,
            prepareWorktree: {
              projectCwd: "/tmp/project",
              branch: "t3code/test-branch",
            },
          }),
        );
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatched,
            gitWorkflow: {
              createWorktree: (request) => {
                createWorktreeRequests.push({
                  refName: request.refName,
                  newRefName: request.newRefName,
                  baseRefName: request.baseRefName,
                });
                return Effect.succeed({
                  worktree: { path: "/tmp/worktrees/test", refName: "t3code/test-branch" },
                });
              },
            },
          }),
        ),
      );

      assert.deepEqual(createWorktreeRequests, [
        { refName: "dev", newRefName: "t3code/test-branch", baseRefName: "dev" },
      ]);
    }),
  );

  it.effect("fails and deletes the created thread when worktree preparation fails", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const result = yield* Effect.gen(function* () {
        const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
        return yield* bootstrap.dispatchTurnStart(
          makeTurnStartCommand({
            createThread: createThreadBootstrap,
            prepareWorktree: {
              projectCwd: "/tmp/project",
              baseBranch: "main",
              branch: "t3code/test-branch",
            },
          }),
        );
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatched,
            gitWorkflow: {
              createWorktree: () => Effect.die(new Error("worktree creation failed")),
            },
          }),
        ),
        Effect.flip,
      );

      assert.equal(result._tag, "OrchestrationDispatchCommandError");
      assert.deepEqual(
        dispatched.map((command) => command.type),
        ["thread.create", "thread.delete"],
      );
    }),
  );

  it.effect("removes the created worktree when the turn start fails after preparation", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const removedWorktrees: Array<{ cwd: string; path: string; force: boolean | undefined }> = [];
      const result = yield* Effect.gen(function* () {
        const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
        return yield* bootstrap.dispatchTurnStart(
          makeTurnStartCommand({
            createThread: createThreadBootstrap,
            prepareWorktree: {
              projectCwd: "/tmp/project",
              baseBranch: "main",
              branch: "t3code/test-branch",
            },
          }),
        );
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatched,
            failTurnStart: true,
            gitWorkflow: {
              removeWorktree: (request) => {
                removedWorktrees.push({
                  cwd: request.cwd,
                  path: request.path,
                  force: request.force,
                });
                return Effect.void;
              },
            },
          }),
        ),
        Effect.flip,
      );

      assert.equal(result._tag, "OrchestrationDispatchCommandError");
      assert.deepEqual(
        dispatched.map((command) => command.type),
        ["thread.create", "thread.meta.update", "thread.turn.start", "thread.delete"],
      );
      assert.deepEqual(removedWorktrees, [
        { cwd: "/tmp/project", path: "/tmp/worktrees/t3code/test-branch", force: true },
      ]);
    }),
  );

  it.effect("reports the bootstrap thread as deleted when cleanup succeeds", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const result = yield* Effect.gen(function* () {
        const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
        return yield* bootstrap.dispatchTurnStart(
          makeTurnStartCommand({
            createThread: createThreadBootstrap,
            prepareWorktree: {
              projectCwd: "/tmp/project",
              baseBranch: "main",
              branch: "t3code/test-branch",
            },
          }),
        );
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatched,
            gitWorkflow: {
              createWorktree: () => Effect.die(new Error("worktree creation failed")),
            },
          }),
        ),
        Effect.flip,
      );

      assert.equal(result._tag, "OrchestrationDispatchCommandError");
      assert.include(result.message, "worktree creation failed");
      assert.strictEqual(result.bootstrapThreadDisposition, "deleted");
      assert.deepEqual(
        dispatched.map((command) => command.type),
        ["thread.create", "thread.delete"],
      );
    }),
  );

  it.effect("does not report a deleted bootstrap thread when cleanup fails", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const removedWorktrees: Array<{ cwd: string; path: string }> = [];
      const result = yield* Effect.gen(function* () {
        const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
        return yield* bootstrap.dispatchTurnStart(
          makeTurnStartCommand({
            createThread: createThreadBootstrap,
            prepareWorktree: {
              projectCwd: "/tmp/project",
              baseBranch: "main",
              branch: "t3code/test-branch",
            },
          }),
        );
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatched,
            failTurnStart: true,
            failThreadDelete: true,
            gitWorkflow: {
              removeWorktree: (request) => {
                removedWorktrees.push({ cwd: request.cwd, path: request.path });
                return Effect.void;
              },
            },
          }),
        ),
        Effect.flip,
      );

      assert.equal(result._tag, "OrchestrationDispatchCommandError");
      assert.include(result.message, "turn start rejected");
      assert.strictEqual(result.bootstrapThreadDisposition, undefined);
      assert.deepEqual(
        dispatched.map((command) => command.type),
        ["thread.create", "thread.meta.update", "thread.turn.start", "thread.delete"],
      );
      // The worktree cleanup must still run when thread deletion fails.
      assert.deepEqual(removedWorktrees, [
        { cwd: "/tmp/project", path: "/tmp/worktrees/t3code/test-branch" },
      ]);
    }),
  );

  it.effect("fails without cleanup when the turn start was not bootstrapped with a thread", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const result = yield* Effect.gen(function* () {
        const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
        return yield* bootstrap.dispatchTurnStart(
          makeTurnStartCommand({
            prepareWorktree: {
              projectCwd: "/tmp/project",
              baseBranch: "main",
              branch: "t3code/test-branch",
            },
          }),
        );
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatched,
            gitWorkflow: {
              createWorktree: () => Effect.die(new Error("worktree creation failed")),
            },
          }),
        ),
        Effect.flip,
      );

      assert.equal(result._tag, "OrchestrationDispatchCommandError");
      assert.deepEqual(dispatched, []);
    }),
  );
});
