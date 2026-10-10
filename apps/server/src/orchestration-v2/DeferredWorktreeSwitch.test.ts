import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadWorktreeSwitch,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  evaluateWorktreeSwitch,
  planWorktreeSwitchSchedule,
  WORKTREE_SWITCH_DETAIL,
} from "./DeferredWorktreeSwitch.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadWorktreeSwitchScheduler from "./ThreadWorktreeSwitchScheduler.ts";
import { reserveWorkspace } from "../workspace/workspaceLease.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const run = (id: string, ordinal: number, status: OrchestrationV2Run["status"]) => ({
  id: RunId.make(id),
  ordinal,
  status,
  requestedAt: at("2026-10-01T00:00:00.000Z"),
  checkpointId: null,
});
const thread = {
  worktreeSwitch: null,
  archiveRequest: null,
  archivedAt: null,
  deletedAt: null,
  worktreePath: null,
  branch: "main",
} as const;
const pendingSwitch: OrchestrationV2ThreadWorktreeSwitch = {
  requestId: CommandId.make("switch"),
  runId: RunId.make("run-1"),
  sourceWorktreePath: null,
  sourceBranch: "main",
  targetPath: "/repo-worktree",
  requestedAt: "2026-10-01T00:00:01.000Z",
  status: "pending",
};
const codex = ProviderDriverKind.make("codex");

describe("planWorktreeSwitchSchedule", () => {
  const plan = (input: Partial<Parameters<typeof planWorktreeSwitchSchedule>[0]> = {}) =>
    planWorktreeSwitchSchedule({
      thread,
      runs: [run("run-1", 1, "running")],
      run: run("run-1", 1, "running"),
      driver: codex,
      targetPath: "/repo-worktree",
      requestId: CommandId.make("switch"),
      now: at("2026-10-01T00:00:01.000Z"),
      ...input,
    });

  it("records the source checkout, the requesting run, and the latest run ordinal", () => {
    assert.deepEqual(plan(), {
      type: "pending",
      request: { ...pendingSwitch, latestRunOrdinal: 1 },
    });
    const runs = [run("run-2", 2, "running"), run("run-1", 1, "completed")];
    const recorded = plan({ runs, run: runs[0]! });
    assert.isTrue(recorded.type === "pending" && recorded.request.latestRunOrdinal === 2);
  });

  it("needs a running Codex run on a live thread without a pending archive", () => {
    assert.equal(plan({ run: null }).type, "reject");
    assert.equal(plan({ driver: ProviderDriverKind.make("claudeAgent") }).type, "reject");
    assert.equal(
      plan({ thread: { ...thread, archivedAt: at("2026-10-01T00:00:00Z") } }).type,
      "reject",
    );
    const archiveRequest = {
      requestId: CommandId.make("archive"),
      runId: null,
      worktreePath: null,
      requestedAt: "2026-10-01T00:00:00.000Z",
      status: "pending" as const,
    };
    assert.equal(plan({ thread: { ...thread, archiveRequest } }).type, "reject");
  });
});

describe("evaluateWorktreeSwitch", () => {
  const evaluate = (input: Partial<Parameters<typeof evaluateWorktreeSwitch>[0]> = {}) =>
    evaluateWorktreeSwitch({
      thread,
      request: pendingSwitch,
      runs: [run("run-1", 1, "completed")],
      checkpoints: [],
      pendingBackgroundTasks: [],
      ...input,
    });

  it("switches only after the run completed and holding background work ended", () => {
    assert.equal(evaluate().type, "switch");
    // A finished turn still capturing its checkpoint keeps the switch waiting.
    assert.equal(evaluate({ runs: [run("run-1", 1, "waiting")] }).type, "wait");
    assert.equal(evaluate({ pendingBackgroundTasks: [{ kind: "subagent" }] }).type, "wait");
    assert.equal(evaluate({ pendingBackgroundTasks: [{ kind: "command" }] }).type, "switch");
  });

  it("cancels on a stopped run, newer work, a checkout change, or an archive", () => {
    const cancel = (detail: string) => ({ type: "cancel" as const, detail });
    assert.deepEqual(
      evaluate({ runs: [run("run-1", 1, "interrupted")] }),
      cancel(WORKTREE_SWITCH_DETAIL.failed),
    );
    // A request recorded before start sequences compares creation order.
    assert.deepEqual(
      evaluate({ runs: [run("run-1", 1, "completed"), run("run-2", 2, "queued")] }),
      cancel(WORKTREE_SWITCH_DETAIL.newWork),
    );
    assert.deepEqual(
      evaluate({ thread: { ...thread, branch: "other" } }),
      cancel(WORKTREE_SWITCH_DETAIL.checkout),
    );
    assert.deepEqual(
      evaluate({ thread: { ...thread, archivedAt: at("2026-10-01T00:00:02Z") } }),
      cancel(WORKTREE_SWITCH_DETAIL.archived),
    );
  });

  it("ignores a later-created run that already ran; any queued run cancels", () => {
    // run-3 was reordered ahead of an edit-held run-2 and ran before run-2 asked.
    const fromRun2 = { ...pendingSwitch, runId: RunId.make("run-2"), latestRunOrdinal: 3 };
    const earlier = run("run-3", 3, "completed");
    assert.equal(
      evaluate({
        request: fromRun2,
        runs: [run("run-1", 1, "completed"), run("run-2", 2, "completed"), earlier],
      }).type,
      "switch",
    );
    // run-3 asked while the older run-2 was held: run-2 would start in the old checkout.
    const fromRun3 = { ...pendingSwitch, runId: RunId.make("run-3"), latestRunOrdinal: 3 };
    assert.deepEqual(evaluate({ request: fromRun3, runs: [run("run-2", 2, "queued"), earlier] }), {
      type: "cancel",
      detail: WORKTREE_SWITCH_DETAIL.newWork,
    });
  });

  it("fails on a failed final checkpoint; a missing one (no Git) still switches", () => {
    const checkpointId = CheckpointId.make("checkpoint-1");
    const runs = [{ ...run("run-1", 1, "completed"), checkpointId }];
    assert.deepEqual(evaluate({ runs, checkpoints: [{ id: checkpointId, status: "error" }] }), {
      type: "fail",
      detail: WORKTREE_SWITCH_DETAIL.checkpointFailed,
    });
    assert.equal(
      evaluate({ runs, checkpoints: [{ id: checkpointId, status: "missing" }] }).type,
      "switch",
    );
  });
});

// Orchestrator integration: the same runtime the server builds, over in-memory
// SQLite, with a real repository for target resolution.
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: codex,
  continuationIdentity: { driverKind: codex, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver: codex,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by worktree switch tests"),
  } as ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-worktree-switch-",
});
const repo = { root: "", worktree: "", projectId: ProjectId.make("worktree-switch-project") };

const TestLayer = ThreadWorktreeSwitchScheduler.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      RuntimeLayer.layer,
      RuntimeLayer.layerEventSink,
      ProjectStore.layer,
      EffectOutbox.layer,
      ThreadCommandExecutor.layer,
    ),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(ServerConfigLayer),
          Layer.provide(PlatformTestLayer),
        ),
      ),
    ),
  ),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
  ),
  Layer.provideMerge(PlatformTestLayer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "DeferredWorktreeSwitch.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

/** A project on a fresh repository with one commit and a linked worktree on `feature/switch`. */
const setupRepository = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-switch-" }));
    repo.root = path.join(root, "repo");
    repo.worktree = path.join(root, "worktree");
    yield* fs.makeDirectory(repo.root);
    yield* git(repo.root, ["init"]);
    yield* git(repo.root, ["config", "user.email", "test@test.com"]);
    yield* git(repo.root, ["config", "user.name", "Test"]);
    yield* fs.writeFileString(path.join(repo.root, "README.md"), "# test\n");
    yield* git(repo.root, ["add", "."]);
    yield* git(repo.root, ["commit", "-m", "initial"]);
    yield* git(repo.root, ["worktree", "add", "-b", "feature/switch", repo.worktree]);
    repo.projectId = ProjectId.make(`worktree-switch-project-${name}`);
    yield* (yield* ProjectStore.ProjectStoreV2).apply({
      sequence: 1,
      eventId: EventId.make(`worktree-switch-project-${name}`),
      aggregateKind: "project",
      aggregateId: repo.projectId,
      occurredAt: "2026-10-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: repo.projectId,
        title: name,
        workspaceRoot: repo.root,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    });
  });

const sendMessage = (
  threadId: ThreadId,
  name: string,
  dispatchMode: { readonly type: "start_immediately" } | { readonly type: "queue_after_active" },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${name}-message`),
      threadId,
      messageId: MessageId.make(`${name}-message`),
      text: "Work",
      attachments: [],
      modelSelection,
      dispatchMode,
    });
    return (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
  });

/** A thread on the project checkout with a running Codex run. */
const startThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`worktree-switch-${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${name}-create`),
      threadId,
      projectId: repo.projectId,
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    const active = yield* sendMessage(threadId, name, { type: "start_immediately" });
    return { threadId, active };
  });

/** Completes `active`; with `checkpointStatus`, after capturing its final checkpoint. */
const completeRun = (
  threadId: ThreadId,
  active: OrchestrationV2Run,
  name: string,
  checkpointStatus?: "ready" | "error",
) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const checkpointId = checkpointStatus === undefined ? null : CheckpointId.make(`${name}-cp`);
    const checkpointEvents: Array<OrchestrationV2DomainEvent> =
      checkpointId === null || checkpointStatus === undefined
        ? []
        : [
            {
              id: EventId.make(`${name}-complete-checkpoint`),
              type: "checkpoint.captured",
              threadId,
              runId: active.id,
              occurredAt: now,
              payload: {
                id: checkpointId,
                threadId,
                scopeId: CheckpointScopeId.make(`${name}-scope`),
                runId: active.id,
                nodeId: NodeId.make(`${name}-node`),
                parentCheckpointId: null,
                ordinalWithinScope: 0,
                appRunOrdinal: active.ordinal,
                ref: CheckpointRef.make(`refs/t3/${name}`),
                status: checkpointStatus,
                files: [],
                capturedAt: now,
              },
            },
          ];
    yield* eventSink.commitCommand({
      commandId: CommandId.make(`${name}-complete`),
      threadId,
      commandType: "checkpoint.capture",
      acceptedAt: now,
      events: [
        ...checkpointEvents,
        {
          id: EventId.make(`${name}-complete-run`),
          type: "run.updated",
          threadId,
          runId: active.id,
          occurredAt: now,
          payload: {
            ...active,
            status: "completed",
            startedAt: now,
            completedAt: now,
            checkpointId,
          },
        },
      ],
      effects: [],
    });
  });

const threadState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).thread;
  });

it.layer(TestLayer)("deferred worktree switch on the orchestrator", (it) => {
  it.effect("waits for the run, survives a restart, switches, then returns to the root", () =>
    Effect.gen(function* () {
      yield* setupRepository("restart");
      const scheduler = yield* ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, active } = yield* startThread("restart");

      const refused = yield* scheduler
        .request({ threadId, targetPath: "relative/path" })
        .pipe(Effect.flip);
      assert.equal(refused.message, "Pass an absolute path to an existing worktree.");

      const pending = yield* scheduler.request({ threadId, targetPath: repo.worktree });
      assert.equal(pending.request?.status, "pending");
      assert.equal(pending.request?.runId, active.id);
      assert.equal(pending.request?.targetPath, repo.worktree);
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.worktreeSwitch?.status,
        "pending",
      );

      // Still running: a recovery pass leaves the checkout alone.
      yield* scheduler.reconcilePending;
      assert.isNull((yield* threadState(threadId)).worktreePath);

      yield* completeRun(threadId, active, "restart");
      // A fresh scheduler (as after a server restart) finds the request from
      // the projection alone and applies it.
      yield* Effect.scoped(
        Effect.flatMap(
          ThreadWorktreeSwitchScheduler.make,
          (restarted) => restarted.reconcilePending,
        ),
      );
      const switched = yield* threadState(threadId);
      assert.equal(switched.worktreePath, repo.worktree);
      assert.equal(switched.branch, "feature/switch");
      assert.equal(switched.worktreeSwitch?.status, "completed");
      assert.equal(switched.worktreeSwitch?.requestId, pending.request?.requestId);

      // The next run asks to return to the project checkout.
      const second = yield* sendMessage(threadId, "restart-second", { type: "start_immediately" });
      yield* scheduler.request({ threadId, targetPath: repo.root });
      yield* completeRun(threadId, second, "restart-second");
      yield* scheduler.reconcilePending;
      const returned = yield* threadState(threadId);
      assert.isNull(returned.worktreePath);
      assert.isNull(returned.branch);
      assert.equal(returned.worktreeSwitch?.status, "completed");
    }).pipe(Effect.scoped),
  );

  it.effect("new work and an archive cancel a pending switch; cancel is idempotent", () =>
    Effect.gen(function* () {
      yield* setupRepository("cancel");
      const scheduler = yield* ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler;
      const orchestrator = yield* Orchestrator.OrchestratorV2;

      const queued = yield* startThread("queued");
      yield* scheduler.request({ threadId: queued.threadId, targetPath: repo.worktree });
      yield* sendMessage(queued.threadId, "queued-second", { type: "queue_after_active" });
      yield* scheduler.reconcilePending;
      const afterQueue = yield* scheduler.status(queued.threadId);
      assert.equal(afterQueue.request?.status, "cancelled");
      assert.equal(afterQueue.request?.detail, WORKTREE_SWITCH_DETAIL.newWork);
      assert.isNull((yield* threadState(queued.threadId)).worktreePath);

      const archived = yield* startThread("archived");
      yield* scheduler.request({ threadId: archived.threadId, targetPath: repo.worktree });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archived-archive"),
        threadId: archived.threadId,
      });
      yield* scheduler.reconcilePending;
      assert.equal(
        (yield* scheduler.status(archived.threadId)).request?.detail,
        WORKTREE_SWITCH_DETAIL.archived,
      );

      const cancelled = yield* startThread("cancelled");
      const first = yield* scheduler.request({
        threadId: cancelled.threadId,
        targetPath: repo.worktree,
      });
      const status = yield* scheduler.cancel({ threadId: cancelled.threadId });
      assert.equal(status.request?.status, "cancelled");
      assert.equal(status.request?.detail, WORKTREE_SWITCH_DETAIL.agent);
      assert.deepEqual(yield* scheduler.cancel({ threadId: cancelled.threadId }), status);
      const stale = yield* orchestrator
        .dispatch({
          type: "thread.worktree-switch.execute",
          commandId: CommandId.make("cancelled-stale-execute"),
          threadId: cancelled.threadId,
          requestId: first.request!.requestId,
          target: { worktreePath: repo.worktree, branch: "feature/switch" },
        })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "OrchestratorDispatchError");
      assert.isNull((yield* threadState(cancelled.threadId)).worktreePath);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects scheduling onto a checkout being removed until removal ends", () =>
    Effect.gen(function* () {
      yield* setupRepository("removing");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId } = yield* startThread("removing");
      const schedule = (name: string) =>
        orchestrator.dispatch({
          type: "thread.worktree-switch.schedule",
          commandId: CommandId.make(name),
          threadId,
          targetPath: repo.worktree,
        });

      const rejected = yield* Effect.scoped(
        Effect.gen(function* () {
          assert.isTrue(yield* reserveWorkspace(repo.worktree, "removal"));
          return yield* schedule("removing-schedule").pipe(Effect.flip);
        }),
      );
      assert.equal(rejected._tag, "OrchestratorDispatchError");
      assert.isNotOk((yield* threadState(threadId)).worktreeSwitch);

      yield* schedule("removing-schedule");
      assert.equal((yield* threadState(threadId)).worktreeSwitch?.status, "pending");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects adopting a checkout being removed until removal ends", () =>
    Effect.gen(function* () {
      yield* setupRepository("adopting");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId } = yield* startThread("adopting");
      const create = orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("adopting-create-onto"),
        threadId: ThreadId.make("worktree-switch-adopting-new"),
        projectId: repo.projectId,
        title: "adopting",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/switch",
        worktreePath: repo.worktree,
      });
      const update = orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("adopting-update"),
        threadId,
        branch: "feature/switch",
        worktreePath: repo.worktree,
      });

      const rejected = yield* Effect.scoped(
        Effect.gen(function* () {
          assert.isTrue(yield* reserveWorkspace(repo.worktree, "removal"));
          return [yield* Effect.flip(create), yield* Effect.flip(update)];
        }),
      );
      assert.deepEqual(
        rejected.map((error) => error._tag),
        ["OrchestratorDispatchError", "OrchestratorDispatchError"],
      );
      assert.isNull((yield* threadState(threadId)).worktreePath);

      // No receipt was recorded, so the same commands commit once removal ends.
      yield* create;
      yield* update;
      assert.equal((yield* threadState(threadId)).worktreePath, repo.worktree);
    }).pipe(Effect.scoped),
  );

  it.effect("records an error and keeps the checkout when the final checkpoint failed", () =>
    Effect.gen(function* () {
      yield* setupRepository("checkpoint-failed");
      const scheduler = yield* ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler;
      const { threadId, active } = yield* startThread("checkpoint-failed");
      yield* scheduler.request({ threadId, targetPath: repo.worktree });
      yield* completeRun(threadId, active, "checkpoint-failed", "error");
      yield* scheduler.reconcilePending;
      const thread = yield* threadState(threadId);
      assert.isNull(thread.worktreePath);
      assert.equal(thread.worktreeSwitch?.status, "error");
      assert.equal(thread.worktreeSwitch?.detail, WORKTREE_SWITCH_DETAIL.checkpointFailed);
    }).pipe(Effect.scoped),
  );

  it.effect("records an error and keeps the checkout when the target disappeared", () =>
    Effect.gen(function* () {
      yield* setupRepository("removed");
      const fs = yield* FileSystem.FileSystem;
      const scheduler = yield* ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler;
      const { threadId, active } = yield* startThread("removed");
      yield* scheduler.request({ threadId, targetPath: repo.worktree });
      yield* fs.remove(repo.worktree, { recursive: true });
      yield* completeRun(threadId, active, "removed");
      yield* scheduler.reconcilePending;
      const thread = yield* threadState(threadId);
      assert.isNull(thread.worktreePath);
      assert.equal(thread.worktreeSwitch?.status, "error");
      assert.equal(
        thread.worktreeSwitch?.detail,
        "The project or target directory no longer exists.",
      );
    }).pipe(Effect.scoped),
  );
});
