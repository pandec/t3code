import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProjectionSnapshotQuery } from "./ProjectionSnapshotQuery.ts";
import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  WORKTREE_SETUP_ACTIVITY_KIND,
  WorktreeSetupSnapshot,
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

const decodeWorktreeSetup = Schema.decodeUnknownSync(WorktreeSetupSnapshot);

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
    inputOrigin: "voice-transcription",
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

const threadShell: OrchestrationThreadShell = {
  ...createThreadBootstrap,
  id: threadId,
  latestTurn: null,
  updatedAt: createThreadBootstrap.createdAt,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  pullRequests: [],
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

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
  readonly afterDispatch?: (command: OrchestrationCommand) => Effect.Effect<void>;
  readonly gitWorkflow?: Partial<GitWorkflowService.GitWorkflowService["Service"]>;
  readonly projectSetupScriptRunner?: Partial<
    ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]
  >;
  readonly tracker?: Partial<WorktreeSetupTracker.WorktreeSetupTracker["Service"]>;
  readonly terminalManager?: Partial<TerminalManager.TerminalManager["Service"]>;
  readonly getThread?: () => Option.Option<OrchestrationThreadShell>;
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
            : Effect.succeed({ sequence: input.dispatched.length }).pipe(
                Effect.tap(() => input.afterDispatch?.(command) ?? Effect.void),
              );
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
        get: () => Effect.succeed(null),
        finish: () => Effect.succeed(null),
        markUncancellable: () => Effect.void,
        ...input.tracker,
      }),
    ),
    Layer.provide(Layer.mock(TerminalManager.TerminalManager)({ ...input.terminalManager })),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.sync(input.getThread ?? (() => Option.some(threadShell))),
      }),
    ),
    Layer.provide(testCryptoLayer),
  );

describe("TurnStartBootstrap", () => {
  for (const { remoteBaseExists, explicitBase } of [
    { remoteBaseExists: true, explicitBase: true },
    { remoteBaseExists: false, explicitBase: true },
    { remoteBaseExists: true, explicitBase: false },
  ]) {
    it.effect(
      `fetches the ${explicitBase ? "requested" : "default"} base and uses ${remoteBaseExists ? "its remote commit" : "the local fallback"}`,
      () =>
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          const fetches: Array<{ cwd: string; remoteName: string; refName?: string }> = [];
          const bases: string[] = [];
          yield* Effect.gen(function* () {
            const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
            yield* bootstrap.dispatchTurnStart(
              makeTurnStartCommand({
                createThread: createThreadBootstrap,
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  ...(explicitBase ? { baseBranch: "main" } : {}),
                  branch: "t3code/test-branch",
                  startFromOrigin: true,
                },
              }),
            );
          }).pipe(
            Effect.provide(
              makeLayer({
                dispatched,
                gitWorkflow: {
                  remoteExists: () => Effect.succeed(true),
                  fetchRemote: (request) =>
                    Effect.sync(() => {
                      fetches.push(request);
                    }),
                  remoteBranchExists: () => Effect.succeed(remoteBaseExists),
                  resolveRemoteTrackingCommit: () =>
                    remoteBaseExists
                      ? Effect.succeed({
                          commitSha: "remote-main-sha",
                          remoteRefName: explicitBase ? "origin/main" : "origin/dev",
                        })
                      : Effect.die("a missing remote branch must use the local base"),
                  createWorktree: (request) =>
                    Effect.sync(() => {
                      bases.push(request.refName);
                      return {
                        worktree: { path: "/tmp/worktrees/test", refName: "t3code/test-branch" },
                      };
                    }),
                },
              }),
            ),
          );
          assert.deepEqual(fetches, [
            { cwd: "/tmp/project", remoteName: "origin", refName: explicitBase ? "main" : "dev" },
          ]);
          assert.deepEqual(bases, [remoteBaseExists ? "remote-main-sha" : "main"]);
          assert.equal(dispatched.at(-1)?.type, "thread.turn.start");
        }),
    );
  }

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
        [
          "thread.create",
          "thread.message.user.append",
          "thread.session.set",
          "thread.meta.update",
          "thread.turn.start",
        ],
      );
      assert.deepEqual(
        dispatchOptions,
        Array.from({ length: dispatched.length }, () => clientOptions),
      );
      const appended = dispatched.find((command) => command.type === "thread.message.user.append");
      assert.equal(appended?.message.inputOrigin, "voice-transcription");
      const metaUpdate = dispatched[3] as Extract<
        OrchestrationCommand,
        { type: "thread.meta.update" }
      >;
      assert.equal(metaUpdate.branch, "t3code/test-branch");
      assert.equal(metaUpdate.worktreePath, "/tmp/worktrees/t3code/test-branch");
      const turnStart = dispatched[4] as TurnStartCommand;
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
                  async: false,
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
      assert.equal(dispatched.length, 8);
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
        ["thread.create", "thread.message.user.append", "thread.session.set", "thread.delete"],
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
        [
          "thread.create",
          "thread.message.user.append",
          "thread.session.set",
          "thread.meta.update",
          "thread.turn.start",
          "thread.delete",
        ],
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
        ["thread.create", "thread.message.user.append", "thread.session.set", "thread.delete"],
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
        [
          "thread.create",
          "thread.message.user.append",
          "thread.session.set",
          "thread.meta.update",
          "thread.turn.start",
          "thread.delete",
          "thread.session.set",
        ],
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
          ["thread.create", "thread.message.user.append", "thread.turn.start"],
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
                  async: false,
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
                  async: false,
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
  for (const disposition of ["archived", "deleted", "replaced"] as const) {
    it.effect(`does not start or delete a thread ${disposition} during detached setup`, () =>
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        const waiting = yield* Deferred.make<void>();
        const complete = yield* Deferred.make<{ exitCode: number | null; durationMs: number }>();
        const completedStages: string[] = [];
        let current: Option.Option<OrchestrationThreadShell> = Option.some(threadShell);
        yield* Effect.gen(function* () {
          const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
          const caller = yield* Effect.forkChild(
            bootstrap
              .dispatchTurnStart(
                makeTurnStartCommand({
                  createThread: createThreadBootstrap,
                  prepareWorktree: {
                    projectCwd: "/tmp/project",
                    baseBranch: "main",
                    branch: "test",
                  },
                  runSetupScript: true,
                }),
              )
              .pipe(Effect.flip),
          );
          yield* Deferred.await(waiting);
          current =
            disposition === "deleted"
              ? Option.none()
              : Option.some({
                  ...threadShell,
                  ...(disposition === "archived"
                    ? { archivedAt: "2026-08-04T00:00:00.000Z" }
                    : { createdAt: "2026-08-04T00:00:00.000Z" }),
                });
          yield* Deferred.succeed(complete, { exitCode: 1, durationMs: 1 });
          const error = yield* Fiber.join(caller);
          assert.include(error.message, "archived, deleted, or replaced");
          assert.isUndefined(error.bootstrapThreadDisposition);
          assert.notInclude(completedStages, "setup-script:failed");
          assert.isFalse(
            dispatched.some(
              (command) => command.type === "thread.turn.start" || command.type === "thread.delete",
            ),
          );
        }).pipe(
          Effect.provide(
            makeLayer({
              dispatched,
              getThread: () => current,
              tracker: {
                stageStatus: (_threadId, stage, status) =>
                  Effect.sync(() => {
                    completedStages.push(`${stage}:${status}`);
                  }),
              },
              projectSetupScriptRunner: {
                runForThread: () =>
                  Effect.succeed({
                    status: "started" as const,
                    async: false,
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
  }

  it.effect(
    "keeps the bootstrap running after its caller disconnects and persists async setup completion",
    () =>
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        const dispatchOptions: Array<DispatchOptions> = [];
        const tracker = yield* WorktreeSetupTracker.make;
        const checkout = yield* Deferred.make<void>();
        const releaseCheckout = yield* Deferred.make<void>();
        const completeScript = yield* Deferred.make<{
          exitCode: number | null;
          durationMs: number;
        }>();
        const handedOff = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const options = { origin: { surface: "cli" } } as const;
        yield* Effect.gen(function* () {
          const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
          const caller = yield* Effect.forkChild(
            bootstrap.dispatchTurnStart(
              makeTurnStartCommand({
                createThread: { ...createThreadBootstrap, titleSource: "manual" },
                prepareWorktree: { projectCwd: "/tmp/project", baseBranch: "main", branch: "test" },
                runSetupScript: true,
              }),
              options,
            ),
          );
          yield* Deferred.await(checkout);
          assert.equal((yield* tracker.get(threadId))?.phase, "running");
          assert.isTrue(
            dispatched.some((command) => command.type === "thread.message.user.append"),
          );
          assert.isTrue(
            dispatched.some(
              (command) => command.type === "thread.create" && command.titleSource === "manual",
            ),
          );
          yield* Fiber.interrupt(caller);
          yield* Deferred.succeed(releaseCheckout, undefined);
          yield* Deferred.await(handedOff);
          assert.isTrue(dispatched.some((command) => command.type === "thread.turn.start"));
          assert.equal((yield* tracker.get(threadId))?.phase, "running");
          yield* Deferred.succeed(completeScript, { exitCode: 1, durationMs: 1 });
          yield* Deferred.await(settled);
          const final = yield* tracker.get(threadId);
          assert.equal(final?.phase, "done");
          assert.equal(
            final?.stages.find((stage) => stage.id === "setup-script")?.status,
            "failed",
          );
          assert.isTrue(dispatchOptions.every((value) => value === options));
          assert.isFalse(dispatched.some((command) => command.type === "thread.delete"));
        }).pipe(
          Effect.provide(
            makeLayer({
              dispatched,
              dispatchOptions,
              tracker,
              afterDispatch: (command) => {
                if (
                  command.type !== "thread.activity.append" ||
                  command.activity.kind !== WORKTREE_SETUP_ACTIVITY_KIND
                )
                  return Effect.void;
                const snapshot = decodeWorktreeSetup(command.activity.payload);
                if (snapshot.phase === "done")
                  return Deferred.succeed(settled, undefined).pipe(Effect.asVoid);
                if (
                  snapshot.phase === "running" &&
                  Array.isArray(snapshot.stages) &&
                  snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done")
                )
                  return Deferred.succeed(handedOff, undefined).pipe(Effect.asVoid);
                return Effect.void;
              },
              gitWorkflow: {
                createWorktree: () =>
                  Deferred.succeed(checkout, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseCheckout)),
                    Effect.as({ worktree: { path: "/tmp/worktrees/test", refName: "test" } }),
                  ),
              },
              projectSetupScriptRunner: {
                runForThread: () =>
                  Effect.succeed({
                    status: "started" as const,
                    async: true,
                    scriptId: "script",
                    scriptName: "Setup",
                    scriptCommand: "install",
                    terminalId: "terminal",
                    cwd: "/tmp/worktrees/test",
                    completion: Deferred.await(completeScript),
                  }),
              },
            }),
          ),
        );
      }),
  );
});

it.effect("refuses mandatory worktree setup outside a Git repository", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const failure = yield* Effect.gen(function* () {
      const bootstrap = yield* TurnStartBootstrap.TurnStartBootstrap;
      return yield* bootstrap.dispatchTurnStart(
        makeTurnStartCommand({
          createThread: createThreadBootstrap,
          prepareWorktree: {
            projectCwd: "/tmp/project",
            branch: "required",
            requireWorktree: true,
          },
        }),
      );
    }).pipe(
      Effect.provide(
        makeLayer({ dispatched, gitWorkflow: { isRepository: () => Effect.succeed(false) } }),
      ),
      Effect.flip,
    );
    assert.match(failure.message, /requires a Git repository/);
    assert.strictEqual(
      dispatched.some((command) => command.type === "thread.turn.start"),
      false,
    );
    assert.strictEqual(failure.bootstrapThreadDisposition, "deleted");
    assert.strictEqual(
      dispatched.some((command) => command.type === "thread.delete"),
      true,
    );
  }),
);
