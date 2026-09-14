import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./OrchestrationEngine.ts";
import * as TurnStartBootstrap from "./TurnStartBootstrap.ts";
import { ThreadDeletionReactor } from "./ThreadDeletionReactor.ts";

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
  readonly tracker?: Partial<WorktreeSetupTracker.WorktreeSetupTracker["Service"]>;
  readonly terminalManager?: Partial<TerminalManager.TerminalManager["Service"]>;
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
        isRepository: () => Effect.succeed(true),
        hasCommit: () => Effect.succeed(true),
        removeWorktree: () => Effect.void,
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
    Layer.provide(
      Layer.mock(ThreadDeletionReactor)({
        // The create fence is exercised by server.test.ts against the real
        // reactor; here it only needs to be a no-op pass-through.
        drainThrough: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({
        begin: () => Effect.void,
        update: () => Effect.void,
        stage: () => Effect.void,
        stageStatus: () => Effect.void,
        appendTail: () => Effect.void,
        finish: () => Effect.void,
        markUncancellable: () => Effect.void,
        ...input.tracker,
      }),
    ),
    Layer.provide(Layer.mock(TerminalManager.TerminalManager)({ ...input.terminalManager })),
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

  it.effect("passes CLI origin through setup activity and cleanup dispatches", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const dispatchOptions: Array<DispatchOptions> = [];
      const clientOptions = {
        origin: { surface: "cli" },
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
                  scriptCommand: "bun install",
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

  for (const missing of ["repository", "commit"] as const) {
    it.effect(`uses the project checkout when the ${missing} is missing`, () =>
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* Effect.gen(function* () {
          const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
          yield* bootstrap.dispatchTurnStart(
            makeTurnStartCommand({
              createThread: createThreadBootstrap,
              prepareWorktree: { projectCwd: "/tmp/project", baseBranch: "main", branch: "test" },
            }),
          );
        }).pipe(
          Effect.provide(
            makeLayer({
              dispatched,
              gitWorkflow: {
                isRepository: () => Effect.succeed(missing !== "repository"),
                hasCommit: () => Effect.succeed(false),
                createWorktree: () => Effect.die("must use the checkout"),
              },
            }),
          ),
        );
        assert.deepEqual(
          dispatched.map((command) => command.type),
          ["thread.create", "thread.turn.start"],
        );
      }),
    );
  }

  it.effect("waits for tracked setup completion before dispatching the first turn", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const waiting = yield* Deferred.make<void>();
      const complete = yield* Deferred.make<{ exitCode: number | null; durationMs: number }>();
      const stages: Array<string> = [];
      yield* Effect.gen(function* () {
        const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
        const dispatch = yield* Effect.forkChild(
          bootstrap.dispatchTurnStart(
            makeTurnStartCommand({
              createThread: createThreadBootstrap,
              prepareWorktree: { projectCwd: "/tmp/project", baseBranch: "main", branch: "test" },
              runSetupScript: true,
            }),
          ),
        );
        yield* Deferred.await(waiting);
        assert.isFalse(dispatched.some((command) => command.type === "thread.turn.start"));
        yield* Deferred.succeed(complete, { exitCode: 1, durationMs: 10 });
        yield* Fiber.join(dispatch);
        assert.equal(dispatched.at(-1)?.type, "thread.turn.start");
        assert.include(stages, "setup-script:failed");
        assert.include(stages, "agent:done");
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatched,
            tracker: {
              stageStatus: (_threadId, stage, status) =>
                Effect.sync(() => {
                  stages.push(`${stage}:${status}`);
                }),
            },
            projectSetupScriptRunner: {
              runForThread: () =>
                Effect.succeed({
                  status: "started" as const,
                  scriptId: "script",
                  scriptName: "Setup",
                  scriptCommand: "install",
                  terminalId: "terminal",
                  cwd: "/tmp/worktrees/test",
                  completion: Deferred.succeed(waiting, undefined).pipe(
                    Effect.andThen(Deferred.await(complete)),
                  ),
                }),
            },
          }),
        ),
      );
    }),
  );

  it.effect("cancels setup, closes its terminal, and removes the created thread and worktree", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const setupFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const waiting = yield* Deferred.make<void>();
      const cleanup: Array<string> = [];
      yield* Effect.gen(function* () {
        const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
        const dispatch = yield* Effect.forkChild(
          bootstrap
            .dispatchTurnStart(
              makeTurnStartCommand({
                createThread: createThreadBootstrap,
                prepareWorktree: { projectCwd: "/tmp/project", baseBranch: "main", branch: "test" },
                runSetupScript: true,
              }),
            )
            .pipe(Effect.flip),
        );
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(yield* Deferred.await(setupFiber));
        const result = yield* Fiber.join(dispatch);
        assert.equal(result.bootstrapThreadDisposition, "deleted");
        assert.equal(result.message, "Worktree setup cancelled.");
        assert.isFalse(dispatched.some((command) => command.type === "thread.turn.start"));
        assert.equal(dispatched.at(-1)?.type, "thread.delete");
        assert.deepEqual(cleanup, ["terminal", "worktree"]);
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatched,
            tracker: {
              begin: ({ fiber }) =>
                fiber ? Deferred.succeed(setupFiber, fiber).pipe(Effect.asVoid) : Effect.void,
            },
            terminalManager: {
              close: () =>
                Effect.sync(() => {
                  cleanup.push("terminal");
                }),
            },
            gitWorkflow: {
              removeWorktree: () =>
                Effect.sync(() => {
                  cleanup.push("worktree");
                }),
            },
            projectSetupScriptRunner: {
              runForThread: () =>
                Effect.succeed({
                  status: "started" as const,
                  scriptId: "script",
                  scriptName: "Setup",
                  scriptCommand: "install",
                  terminalId: "terminal",
                  cwd: "/tmp/worktrees/test",
                  completion: Deferred.succeed(waiting, undefined).pipe(
                    Effect.andThen(Effect.never),
                  ),
                }),
            },
          }),
        ),
      );
    }),
  );
});
