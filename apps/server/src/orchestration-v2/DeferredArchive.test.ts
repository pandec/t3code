import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadArchiveRequest,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ArchiveWorktreeRemoval from "./ArchiveWorktreeRemoval.ts";
import {
  ARCHIVE_CANCEL_DETAIL,
  evaluateDeferredArchive,
  finishedWorktreeRemoval,
  planArchiveSchedule,
  stopCancelsArchive,
  worktreeRemovalRequest,
} from "./DeferredArchive.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "./runtimeLayer.ts";
import * as ThreadArchiveScheduler from "./ThreadArchiveScheduler.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const run = (
  id: string,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  requestedAt = "2026-10-01T00:00:00.000Z",
) => ({ id: RunId.make(id), ordinal, status, requestedAt: at(requestedAt) });
const pendingRequest = (
  overrides: Partial<OrchestrationV2ThreadArchiveRequest> = {},
): OrchestrationV2ThreadArchiveRequest => ({
  requestId: CommandId.make("request"),
  runId: RunId.make("run-1"),
  worktreePath: "/work/tree",
  requestedAt: "2026-10-01T00:00:01.000Z",
  status: "pending",
  ...overrides,
});
const idleThread = {
  archiveRequest: null,
  archivedAt: null,
  deletedAt: null,
  worktreePath: "/work/tree",
} as const;
const schedule = (input: Partial<Parameters<typeof planArchiveSchedule>[0]> = {}) =>
  planArchiveSchedule({
    thread: idleThread,
    runs: [],
    pendingBackgroundTasks: [],
    afterTurn: true,
    requestId: CommandId.make("request"),
    now: at("2026-10-01T00:00:01.000Z"),
    ...input,
  });

describe("planArchiveSchedule", () => {
  it("archives an idle thread now unless background work holds completion", () => {
    assert.deepInclude(schedule(), { type: "archive" });
    // Commands (dev servers) do not hold completion; subagents do.
    assert.deepInclude(schedule({ pendingBackgroundTasks: [{ kind: "command" }] }), {
      type: "archive",
    });
    const waiting = schedule({ pendingBackgroundTasks: [{ kind: "subagent" }] });
    assert.equal(waiting.type, "pending");
    assert.isTrue(waiting.type === "pending" && waiting.request.runId === null);
  });

  it("waits on the active run only when scheduled after the turn", () => {
    const runs = [run("run-1", 1, "completed"), run("run-2", 2, "running")];
    const plan = schedule({ runs });
    assert.isTrue(plan.type === "pending" && plan.request.runId === RunId.make("run-2"));
    assert.equal(schedule({ runs, afterTurn: false }).type, "reject");
    // A finished turn still capturing its checkpoint is waited on too.
    const capturing = schedule({ runs: [run("run-1", 1, "waiting")], afterTurn: true });
    assert.isTrue(capturing.type === "pending" && capturing.request.runId === RunId.make("run-1"));
  });

  it("rejects archived threads, a second request, and queued messages", () => {
    assert.equal(
      schedule({ thread: { ...idleThread, archivedAt: at("2026-10-01T00:00:00Z") } }).type,
      "reject",
    );
    assert.equal(
      schedule({ thread: { ...idleThread, archiveRequest: pendingRequest() } }).type,
      "reject",
    );
    assert.equal(
      schedule({ runs: [run("run-1", 1, "running"), run("run-2", 2, "queued")] }).type,
      "reject",
    );
  });
});

describe("archive with worktree removal", () => {
  it("needs a worktree and stays pending after an immediate archive", () => {
    assert.deepEqual(
      schedule({ removeWorktree: true, thread: { ...idleThread, worktreePath: null } }),
      { type: "reject", detail: "This thread has no worktree to remove." },
    );
    const plan = schedule({ removeWorktree: true });
    assert.isTrue(
      plan.type === "archive" &&
        plan.request.status === "pending" &&
        plan.request.removeWorktree === true,
    );
    // Without removal the immediate archive completes the request.
    const plain = schedule();
    assert.isTrue(plain.type === "archive" && plain.request.status === "completed");
  });

  it("tracks removal only on an archived, undeleted thread and records its outcome", () => {
    const request = pendingRequest({ removeWorktree: true });
    const archivedAt = at("2026-10-01T00:00:02Z");
    assert.isNull(
      worktreeRemovalRequest({ archiveRequest: request, archivedAt: null, deletedAt: null }),
    );
    assert.equal(
      worktreeRemovalRequest({ archiveRequest: request, archivedAt, deletedAt: null }),
      request,
    );
    assert.isNull(
      worktreeRemovalRequest({ archiveRequest: request, archivedAt, deletedAt: archivedAt }),
    );
    assert.isNull(
      worktreeRemovalRequest({ archiveRequest: pendingRequest(), archivedAt, deletedAt: null }),
    );
    assert.equal(finishedWorktreeRemoval(request, undefined).status, "completed");
    assert.deepInclude(finishedWorktreeRemoval(request, "Dirty."), {
      status: "error",
      detail: "Dirty.",
      removeWorktree: true,
    });
  });
});

describe("evaluateDeferredArchive", () => {
  const evaluate = (input: Partial<Parameters<typeof evaluateDeferredArchive>[0]> = {}) =>
    evaluateDeferredArchive({
      thread: { worktreePath: "/work/tree" },
      request: pendingRequest(),
      runs: [run("run-1", 1, "completed")],
      pendingBackgroundTasks: [],
      ...input,
    });

  it("archives only after the run completed and holding background work ended", () => {
    assert.equal(evaluate().type, "archive");
    assert.equal(evaluate({ runs: [run("run-1", 1, "waiting")] }).type, "wait");
    assert.equal(evaluate({ pendingBackgroundTasks: [{ kind: "monitor" }] }).type, "wait");
  });

  it("cancels on a stopped run, newer work, or a workspace change", () => {
    assert.deepEqual(evaluate({ runs: [run("run-1", 1, "interrupted")] }), {
      type: "cancel",
      detail: ARCHIVE_CANCEL_DETAIL.failed,
    });
    assert.deepEqual(
      evaluate({ runs: [run("run-1", 1, "completed"), run("run-2", 2, "running")] }),
      {
        type: "cancel",
        detail: ARCHIVE_CANCEL_DETAIL.newWork,
      },
    );
    assert.deepEqual(evaluate({ thread: { worktreePath: null } }), {
      type: "cancel",
      detail: ARCHIVE_CANCEL_DETAIL.workspace,
    });
    // An idle request compares run request times instead of a run id.
    const idle = pendingRequest({ runId: null });
    assert.equal(evaluate({ request: idle }).type, "archive");
    assert.equal(
      evaluate({ request: idle, runs: [run("run-2", 2, "running", "2026-10-01T00:00:02.000Z")] })
        .type,
      "cancel",
    );
  });
});

describe("stopCancelsArchive", () => {
  it("cancels only for the awaited run while it is still running", () => {
    const request = pendingRequest();
    assert.isTrue(stopCancelsArchive(request, [run("run-1", 1, "running")], RunId.make("run-1")));
    assert.isFalse(stopCancelsArchive(request, [run("run-1", 1, "waiting")], RunId.make("run-1")));
    assert.isFalse(stopCancelsArchive(request, [run("run-2", 2, "running")], RunId.make("run-2")));
  });
});

// Orchestrator integration: the same runtime the server builds, over in-memory SQLite.
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by deferred archive tests"),
  } as ProviderAdapterV2Shape,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-deferred-archive-",
});
// The guarded removal itself is covered by ArchiveWorktreeRemoval.test.ts.
const removal = {
  blocker: null as string | null,
  outcome: null as string | null,
  removed: [] as Array<string>,
};
const FakeWorktreeRemoval = Layer.succeed(
  ArchiveWorktreeRemoval.ArchiveWorktreeRemoval,
  ArchiveWorktreeRemoval.ArchiveWorktreeRemoval.of({
    blocker: () => Effect.sync(() => removal.blocker),
    remove: ({ worktreePath }) =>
      Effect.sync(() => {
        removal.removed.push(worktreePath);
        return removal.outcome;
      }),
  }),
);
const resetRemoval = (input: Partial<Omit<typeof removal, "removed">> = {}) =>
  Effect.sync(() => {
    removal.blocker = input.blocker ?? null;
    removal.outcome = input.outcome ?? null;
    removal.removed = [];
  });

const TestLayer = ThreadArchiveScheduler.layer.pipe(
  Layer.provideMerge(FakeWorktreeRemoval),
  Layer.provideMerge(
    Layer.mergeAll(
      OrchestrationV2LayerLive,
      OrchestrationV2EventSinkLayerLive,
      ProjectStore.layer,
      EffectOutbox.layer,
      ThreadCommandExecutor.layer,
    ),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
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
  Layer.provide(PlatformTestLayer),
);

const createThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`deferred-archive-${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${name}-create`),
      threadId,
      projectId: ProjectId.make("deferred-archive-project"),
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: `/tmp/deferred-archive-${name}`,
    });
    return threadId;
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

const threadState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).thread;
  });

it.layer(TestLayer)("deferred archive on the orchestrator", (it) => {
  it.effect("archives an idle thread immediately and records the completed request", () =>
    Effect.gen(function* () {
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* createThread("idle");
      const status = yield* scheduler.schedule({ threadId, afterTurn: false });
      assert.isNotNull(status.archivedAt);
      assert.equal(status.request?.status, "completed");
      const shell = (yield* orchestrator.getShellSnapshot()).archivedThreads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.archiveRequest?.status, "completed");
    }),
  );

  it.effect("waits for the run, survives a scheduler restart, then archives", () =>
    Effect.gen(function* () {
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = yield* createThread("after-turn");
      const active = yield* sendMessage(threadId, "after-turn", { type: "start_immediately" });

      const refused = yield* scheduler.schedule({ threadId, afterTurn: false }).pipe(Effect.flip);
      assert.equal(refused._tag, "ThreadArchiveSchedulerError");
      const pending = yield* scheduler.schedule({ threadId, afterTurn: true });
      assert.isNull(pending.archivedAt);
      assert.equal(pending.request?.status, "pending");
      assert.equal(pending.request?.runId, active.id);
      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.equal(shell?.archiveRequest?.status, "pending");

      // Still running: a recovery pass leaves the request pending.
      yield* scheduler.reconcilePending;
      assert.isNull((yield* threadState(threadId)).archivedAt);

      const now = yield* DateTime.now;
      yield* eventSink.commitCommand({
        commandId: CommandId.make("after-turn-complete"),
        threadId,
        commandType: "checkpoint.capture",
        acceptedAt: now,
        events: [
          {
            id: EventId.make("after-turn-complete-run"),
            type: "run.updated",
            threadId,
            runId: active.id,
            occurredAt: now,
            payload: { ...active, status: "completed", startedAt: now, completedAt: now },
          },
        ],
        effects: [],
      });

      // A fresh scheduler (as after a server restart) finds the request from
      // the projection alone and runs it.
      yield* Effect.scoped(
        Effect.flatMap(ThreadArchiveScheduler.make, (restarted) => restarted.reconcilePending),
      ).pipe(Effect.provide(NodeServices.layer));
      const thread = yield* threadState(threadId);
      assert.isNotNull(thread.archivedAt);
      assert.equal(thread.archiveRequest?.status, "completed");
      assert.equal(thread.archiveRequest?.requestId, pending.request?.requestId);
    }),
  );

  it.effect("a new message cancels a pending archive", () =>
    Effect.gen(function* () {
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const threadId = yield* createThread("new-message");
      yield* sendMessage(threadId, "new-message-first", { type: "start_immediately" });
      yield* scheduler.schedule({ threadId, afterTurn: true });
      yield* sendMessage(threadId, "new-message-second", { type: "queue_after_active" });
      const status = yield* scheduler.status(threadId);
      assert.equal(status.request?.status, "cancelled");
      assert.equal(status.request?.detail, ARCHIVE_CANCEL_DETAIL.newWork);
    }),
  );

  it.effect("Stop cancels a pending archive waiting on the stopped run", () =>
    Effect.gen(function* () {
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* createThread("stop");
      const active = yield* sendMessage(threadId, "stop", { type: "start_immediately" });
      yield* scheduler.schedule({ threadId, afterTurn: true });
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop-interrupt"),
        threadId,
        runId: active.id,
      });
      const status = yield* scheduler.status(threadId);
      assert.equal(status.request?.status, "cancelled");
      assert.equal(status.request?.detail, ARCHIVE_CANCEL_DETAIL.stopped);
    }),
  );

  it.effect("cancel, manual archive, and stale execution leave the request consistent", () =>
    Effect.gen(function* () {
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* createThread("cancel");
      yield* sendMessage(threadId, "cancel", { type: "start_immediately" });
      const first = yield* scheduler.schedule({ threadId, afterTurn: true });
      const cancelled = yield* scheduler.cancel({ threadId });
      assert.equal(cancelled.request?.status, "cancelled");
      assert.equal(cancelled.request?.detail, ARCHIVE_CANCEL_DETAIL.user);
      // Cancelling again is a no-op that reports the current state.
      assert.deepEqual(yield* scheduler.cancel({ threadId }), cancelled);

      const stale = yield* orchestrator
        .dispatch({
          type: "thread.archive.execute",
          commandId: CommandId.make("cancel-stale-execute"),
          threadId,
          requestId: first.request!.requestId,
        })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "OrchestratorDispatchError");

      yield* scheduler.schedule({ threadId, afterTurn: true });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cancel-manual-archive"),
        threadId,
      });
      const thread = yield* threadState(threadId);
      assert.isNotNull(thread.archivedAt);
      assert.equal(thread.archiveRequest?.status, "cancelled");
      assert.equal(thread.archiveRequest?.detail, ARCHIVE_CANCEL_DETAIL.manual);
    }),
  );

  it.effect("removes the worktree after an idle archive and records the outcome", () =>
    Effect.gen(function* () {
      yield* resetRemoval();
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const threadId = yield* createThread("remove-idle");
      const archived = yield* scheduler.schedule({
        threadId,
        afterTurn: false,
        removeWorktree: true,
      });
      // Archived right away; the request stays pending until removal finishes.
      assert.isNotNull(archived.archivedAt);
      assert.equal(archived.request?.status, "pending");
      assert.isTrue(archived.request?.removeWorktree);

      yield* scheduler.reconcilePending;
      assert.deepEqual(removal.removed, ["/tmp/deferred-archive-remove-idle"]);
      const status = yield* scheduler.status(threadId);
      assert.equal(status.request?.status, "completed");
      assert.isNotNull(status.archivedAt);
    }),
  );

  it.effect("waits for the turn, then records why the worktree was kept", () =>
    Effect.gen(function* () {
      yield* resetRemoval({ outcome: ArchiveWorktreeRemoval.WORKTREE_KEPT_DETAIL.dirty });
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = yield* createThread("remove-after-turn");
      const active = yield* sendMessage(threadId, "remove-after-turn", {
        type: "start_immediately",
      });
      yield* scheduler.schedule({ threadId, afterTurn: true, removeWorktree: true });
      yield* scheduler.reconcilePending;
      assert.deepEqual(removal.removed, []);

      const now = yield* DateTime.now;
      yield* eventSink.commitCommand({
        commandId: CommandId.make("remove-after-turn-complete"),
        threadId,
        commandType: "checkpoint.capture",
        acceptedAt: now,
        events: [
          {
            id: EventId.make("remove-after-turn-complete-run"),
            type: "run.updated",
            threadId,
            runId: active.id,
            occurredAt: now,
            payload: { ...active, status: "completed", startedAt: now, completedAt: now },
          },
        ],
        effects: [],
      });
      // One pass archives; the next one (the event stream's job when the
      // worker runs, or recovery after a restart) removes the worktree.
      yield* scheduler.reconcilePending;
      yield* scheduler.reconcilePending;
      assert.deepEqual(removal.removed, ["/tmp/deferred-archive-remove-after-turn"]);
      const thread = yield* threadState(threadId);
      assert.isNotNull(thread.archivedAt);
      assert.equal(thread.archiveRequest?.status, "error");
      assert.equal(
        thread.archiveRequest?.detail,
        ArchiveWorktreeRemoval.WORKTREE_KEPT_DETAIL.dirty,
      );
    }),
  );

  it.effect("refuses up front a worktree that can never qualify", () =>
    Effect.gen(function* () {
      yield* resetRemoval({ blocker: ArchiveWorktreeRemoval.WORKTREE_KEPT_DETAIL.shared });
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const threadId = yield* createThread("remove-shared");
      const refused = yield* scheduler
        .schedule({ threadId, afterTurn: false, removeWorktree: true })
        .pipe(Effect.flip);
      assert.equal(refused.detail, ArchiveWorktreeRemoval.WORKTREE_KEPT_DETAIL.shared);
      const status = yield* scheduler.status(threadId);
      assert.isNull(status.archivedAt);
      assert.isNull(status.request);
    }),
  );

  it.effect("unarchiving before removal keeps the worktree", () =>
    Effect.gen(function* () {
      yield* resetRemoval();
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* createThread("remove-unarchive");
      const archived = yield* scheduler.schedule({
        threadId,
        afterTurn: false,
        removeWorktree: true,
      });
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("remove-unarchive-unarchive"),
        threadId,
      });
      yield* scheduler.reconcilePending;
      assert.deepEqual(removal.removed, []);
      const status = yield* scheduler.status(threadId);
      assert.isNull(status.archivedAt);
      assert.equal(status.request?.status, "cancelled");
      assert.equal(status.request?.detail, ARCHIVE_CANCEL_DETAIL.unarchived);
      const late = yield* orchestrator
        .dispatch({
          type: "thread.archive.complete",
          commandId: CommandId.make("remove-unarchive-late-complete"),
          threadId,
          requestId: archived.request!.requestId,
        })
        .pipe(Effect.flip);
      assert.equal(late._tag, "OrchestratorDispatchError");
    }),
  );

  it.effect("a user's message unarchives an archived thread, then starts its turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* createThread("message-unarchive");
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("message-unarchive-archive"),
        threadId,
      });
      const run = yield* sendMessage(threadId, "message-unarchive", {
        type: "start_immediately",
      });
      assert.notEqual(run.status, "queued");
      assert.isNull((yield* threadState(threadId)).archivedAt);
      const snapshot = yield* orchestrator.getShellSnapshot();
      assert.isTrue(snapshot.threads.some((thread) => thread.id === threadId));
      assert.isFalse(snapshot.archivedThreads.some((thread) => thread.id === threadId));
    }),
  );

  it.effect("messaging before removal reopens the thread and keeps the worktree", () =>
    Effect.gen(function* () {
      yield* resetRemoval();
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const threadId = yield* createThread("remove-message");
      yield* scheduler.schedule({ threadId, afterTurn: false, removeWorktree: true });
      yield* sendMessage(threadId, "remove-message", { type: "start_immediately" });
      yield* scheduler.reconcilePending;
      assert.deepEqual(removal.removed, []);
      const status = yield* scheduler.status(threadId);
      assert.isNull(status.archivedAt);
      assert.equal(status.request?.status, "cancelled");
      assert.equal(status.request?.detail, ARCHIVE_CANCEL_DETAIL.unarchived);
    }),
  );

  it.effect("an agent's message leaves the thread archived and its removal pending", () =>
    Effect.gen(function* () {
      yield* resetRemoval();
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* createThread("remove-agent-message");
      yield* scheduler.schedule({ threadId, afterTurn: false, removeWorktree: true });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("remove-agent-message"),
        threadId,
        messageId: MessageId.make("remove-agent-message"),
        text: "Work",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });
      const thread = yield* threadState(threadId);
      assert.isNotNull(thread.archivedAt);
      assert.equal(thread.archiveRequest?.status, "pending");
    }),
  );
});
