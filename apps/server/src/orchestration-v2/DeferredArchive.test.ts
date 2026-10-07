import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { ArchiveToolkitHandlersLive } from "../mcp/toolkits/archive/handlers.ts";
import { ArchiveToolkit } from "../mcp/toolkits/archive/tools.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { reserveWorkspace } from "../workspace/workspaceLease.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ArchiveWorktreeRemoval from "./ArchiveWorktreeRemoval.ts";
import {
  ARCHIVE_CANCEL_DETAIL,
  evaluateDeferredArchive,
  finishedWorktreeRemoval,
  planArchiveSchedule,
  restartContinuationPending,
  stopCancelsArchive,
  wakeRetargetedArchiveRequest,
  worktreeRemovalRequest,
} from "./DeferredArchive.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { OrchestratorProjectionError } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadArchiveScheduler from "./ThreadArchiveScheduler.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const run = (
  id: string,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  requestedAt = "2026-10-01T00:00:00.000Z",
) => ({
  id: RunId.make(id),
  ordinal,
  status,
  requestedAt: at(requestedAt),
  checkpointId: null,
});
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
      checkpoints: [],
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

describe("evaluateDeferredArchive checkpoint outcome", () => {
  it("fails on a failed final checkpoint; a missing one (no Git) still archives", () => {
    const checkpointId = CheckpointId.make("checkpoint-1");
    const evaluate = (status: "error" | "missing") =>
      evaluateDeferredArchive({
        thread: { worktreePath: "/work/tree" },
        request: pendingRequest(),
        runs: [{ ...run("run-1", 1, "completed"), checkpointId }],
        checkpoints: [{ id: checkpointId, status }],
        pendingBackgroundTasks: [],
      });
    assert.deepEqual(evaluate("error"), {
      type: "fail",
      detail: ARCHIVE_CANCEL_DETAIL.checkpointFailed,
    });
    assert.equal(evaluate("missing").type, "archive");
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

describe("wake runs", () => {
  // The real queued shape: requested after the archive, no workStartedAt until it starts.
  const wake = (id: string, ordinal: number, status: OrchestrationV2Run["status"]) => ({
    ...run(id, ordinal, status, "2026-10-01T00:00:02.000Z"),
    startedAt: null,
    completedAt: status === "cancelled" ? at("2026-10-01T00:00:03.000Z") : null,
  });

  it("moves a pending archive to the run a wake started, never backwards", () => {
    const runs = [
      { ...run("run-1", 1, "running"), userMessageId: MessageId.make("prompt") },
      { ...run("run-2", 2, "queued"), userMessageId: MessageId.make("wake") },
    ];
    assert.equal(
      wakeRetargetedArchiveRequest(pendingRequest(), runs, MessageId.make("wake"))?.runId,
      RunId.make("run-2"),
    );
    // A request waiting only on background work moves too.
    assert.equal(
      wakeRetargetedArchiveRequest(pendingRequest({ runId: null }), runs, MessageId.make("wake"))
        ?.runId,
      RunId.make("run-2"),
    );
    // A wake that steered into the awaited run moves nothing.
    assert.isNull(wakeRetargetedArchiveRequest(pendingRequest(), runs, MessageId.make("prompt")));
    assert.isNull(wakeRetargetedArchiveRequest(pendingRequest(), runs, MessageId.make("other")));
  });

  it("a wake withdrawn before it started falls back to the run before it", () => {
    const request = pendingRequest({ runId: RunId.make("run-2") });
    const evaluate = (
      runs: ReadonlyArray<Parameters<typeof evaluateDeferredArchive>[0]["runs"][number]>,
    ) =>
      evaluateDeferredArchive({
        thread: { worktreePath: "/work/tree" },
        request,
        runs,
        checkpoints: [],
        pendingBackgroundTasks: [],
      });
    assert.equal(
      evaluate([run("run-1", 1, "running"), wake("run-2", 2, "cancelled")]).type,
      "wait",
    );
    assert.equal(
      evaluate([run("run-1", 1, "completed"), wake("run-2", 2, "cancelled")]).type,
      "archive",
    );
    assert.deepEqual(evaluate([run("run-1", 1, "interrupted"), wake("run-2", 2, "cancelled")]), {
      type: "cancel",
      detail: ARCHIVE_CANCEL_DETAIL.failed,
    });
    // A run that settled before the archive was scheduled is not waited on.
    const settledEarlier = {
      ...run("run-1", 1, "interrupted"),
      completedAt: at("2026-10-01T00:00:00.500Z"),
    };
    assert.equal(evaluate([settledEarlier, wake("run-2", 2, "cancelled")]).type, "archive");
    // A wake that started and was then cancelled still voids the archive.
    assert.equal(
      evaluate([
        run("run-1", 1, "completed"),
        { ...wake("run-2", 2, "cancelled"), startedAt: at("2026-10-01T00:00:02.000Z") },
      ]).type,
      "cancel",
    );
    // A run cancelled before it started but requested before the archive is no wake.
    assert.deepEqual(
      evaluate([
        run("run-1", 1, "completed"),
        { ...run("run-2", 2, "cancelled"), startedAt: null, completedAt: null },
      ]),
      { type: "cancel", detail: ARCHIVE_CANCEL_DETAIL.failed },
    );
  });

  it("a failed final checkpoint of the run before a wake still fails the archive", () => {
    const checkpointId = CheckpointId.make("cp-1");
    // Scheduled while run-1 ran; run-1 finished after that, then the wake took over.
    const parent = {
      ...run("run-1", 1, "completed"),
      checkpointId,
      completedAt: at("2026-10-01T00:00:02.000Z"),
    };
    const evaluate = (status: "error" | "ready", wakeStatus: OrchestrationV2Run["status"]) =>
      evaluateDeferredArchive({
        thread: { worktreePath: "/work/tree" },
        request: pendingRequest({ runId: RunId.make("run-2") }),
        runs: [parent, wake("run-2", 2, wakeStatus)],
        checkpoints: [{ id: checkpointId, status }],
        pendingBackgroundTasks: [],
      });
    const failed = { type: "fail", detail: ARCHIVE_CANCEL_DETAIL.checkpointFailed } as const;
    assert.deepEqual(evaluate("error", "queued"), failed);
    assert.deepEqual(evaluate("error", "completed"), failed);
    assert.equal(evaluate("ready", "completed").type, "archive");
  });

  it("a stop or failure anywhere in the awaited chain cancels", () => {
    const evaluate = (
      runs: ReadonlyArray<Parameters<typeof evaluateDeferredArchive>[0]["runs"][number]>,
    ) =>
      evaluateDeferredArchive({
        thread: { worktreePath: "/work/tree" },
        request: pendingRequest({ runId: RunId.make("run-2") }),
        runs,
        checkpoints: [],
        pendingBackgroundTasks: [],
      });
    const settled = (status: OrchestrationV2Run["status"], completedAt: string) => ({
      ...run("run-1", 1, status),
      startedAt: at("2026-10-01T00:00:00.000Z"),
      completedAt: at(completedAt),
    });
    const failed = { type: "cancel", detail: ARCHIVE_CANCEL_DETAIL.failed } as const;
    // The parent failed after the archive moved onto its queued wake.
    const failedParent = settled("failed", "2026-10-01T00:00:02.500Z");
    assert.deepEqual(evaluate([failedParent, wake("run-2", 2, "queued")]), failed);
    assert.deepEqual(evaluate([failedParent, wake("run-2", 2, "completed")]), failed);
    // A run that settled before the archive was scheduled does not count.
    assert.equal(
      evaluate([settled("failed", "2026-10-01T00:00:00.500Z"), wake("run-2", 2, "completed")]).type,
      "archive",
    );
    // Restart recovery cancelled the parent, and its continuation carried the work on.
    for (const status of ["cancelled", "interrupted"] as const) {
      assert.equal(
        evaluate([
          settled(status, "2026-10-01T00:00:02.500Z"),
          { ...wake("run-2", 2, "completed"), restartContinuationOfRunId: RunId.make("run-1") },
        ]).type,
        "archive",
      );
    }
  });

  it("an unsettled restart continuation holds the archive", () => {
    const evaluate = (
      request: OrchestrationV2ThreadArchiveRequest,
      runs: ReadonlyArray<Parameters<typeof evaluateDeferredArchive>[0]["runs"][number]>,
    ) =>
      evaluateDeferredArchive({
        thread: { worktreePath: "/work/tree" },
        request,
        runs,
        checkpoints: [],
        pendingBackgroundTasks: [],
        restartContinuationPending: true,
      });
    const held = {
      type: "wait",
      detail: "A restart continuation is waiting to resume the agent.",
    } as const;
    // Recovery cancelled the running turn: the continuation may still take it over.
    const cancelled = {
      ...run("run-1", 1, "cancelled"),
      startedAt: at("2026-10-01T00:00:00.000Z"),
      completedAt: at("2026-10-01T00:00:02.000Z"),
    };
    assert.deepEqual(evaluate(pendingRequest(), [cancelled]), held);
    // Recovery cleared the background work a settled turn waited on.
    assert.deepEqual(
      evaluate(pendingRequest({ runId: null }), [run("run-1", 1, "completed")]),
      held,
    );
  });

  it("a reserved delegated result holds the archive until its wake run finishes", () => {
    const wakeMessageId = MessageId.make("wake");
    const parent = {
      ...run("run-1", 1, "completed"),
      userMessageId: MessageId.make("prompt"),
      delegatedCompletion: {
        disposition: "open" as const,
        nextGeneration: 2,
        delivery: { generation: 1, messageId: wakeMessageId, taskIds: [NodeId.make("task")] },
      },
    };
    // An idle thread does not archive at once while the wake is still to come.
    const plan = schedule({ runs: [parent] });
    assert.isTrue(plan.type === "pending" && plan.request.runId === null);
    const evaluate = (
      request: OrchestrationV2ThreadArchiveRequest,
      runs: ReadonlyArray<Parameters<typeof evaluateDeferredArchive>[0]["runs"][number]>,
    ) =>
      evaluateDeferredArchive({
        thread: { worktreePath: "/work/tree" },
        request,
        runs,
        checkpoints: [],
        pendingBackgroundTasks: [],
      });
    // The parent finished and the task is terminal, but the wake has not dispatched yet.
    assert.deepEqual(evaluate(pendingRequest(), [parent]), {
      type: "wait",
      detail: "A delegated result is waiting to wake the agent.",
    });
    // The wake dispatched and the request moved onto its run.
    const wakeRun = { ...wake("run-2", 2, "running"), userMessageId: wakeMessageId };
    const retargeted = wakeRetargetedArchiveRequest(
      pendingRequest(),
      [parent, wakeRun],
      wakeMessageId,
    );
    assert.equal(retargeted?.runId, RunId.make("run-2"));
    assert.equal(evaluate(retargeted!, [parent, wakeRun]).type, "wait");
    // The wake finished, but the terminal-run listener has not reconciled its
    // delivery yet: it may still reserve a follow-up for later results.
    const completedWake = { ...wakeRun, status: "completed" as const };
    assert.deepEqual(evaluate(retargeted!, [parent, completedWake]), {
      type: "wait",
      detail: "A delegated result is waiting to wake the agent.",
    });
    const reconciled = (delivery: (typeof parent)["delegatedCompletion"]["delivery"] | null) => ({
      ...parent,
      delegatedCompletion: { ...parent.delegatedCompletion, delivery },
    });
    assert.equal(evaluate(retargeted!, [reconciled(null), completedWake]).type, "archive");
    // It reserved a follow-up whose wake has not dispatched yet.
    const followUp = reconciled({
      generation: 2,
      messageId: MessageId.make("follow-up"),
      taskIds: [NodeId.make("task-2")],
    });
    assert.equal(evaluate(retargeted!, [followUp, completedWake]).type, "wait");
  });

  it("Stop of the run before a queued wake still cancels", () => {
    const request = pendingRequest({ runId: RunId.make("run-2") });
    const runs = [run("run-1", 1, "running"), wake("run-2", 2, "queued")];
    assert.isTrue(stopCancelsArchive(request, runs, RunId.make("run-1")));
  });
});

describe("a reordered queue", () => {
  // run-3 was reordered ahead of an edit-held run-2, so it ran first.
  const settled = (
    id: string,
    ordinal: number,
    status: OrchestrationV2Run["status"],
    completedAt: string | null = null,
  ) => ({
    ...run(id, ordinal, status),
    startedAt: at("2026-10-01T00:00:00.000Z"),
    completedAt: completedAt === null ? null : at(completedAt),
  });
  const first = settled("run-1", 1, "completed", "2026-10-01T00:00:00.100Z");
  const reordered = settled("run-3", 3, "completed", "2026-10-01T00:00:00.500Z");
  const request = pendingRequest({ runId: RunId.make("run-2"), latestRunOrdinal: 3 });
  const evaluate = (
    archiveRequest: OrchestrationV2ThreadArchiveRequest,
    runs: ReadonlyArray<Parameters<typeof evaluateDeferredArchive>[0]["runs"][number]>,
  ) =>
    evaluateDeferredArchive({
      thread: { worktreePath: "/work/tree" },
      request: archiveRequest,
      runs,
      checkpoints: [],
      pendingBackgroundTasks: [],
    });

  it("records the latest run ordinal when scheduled", () => {
    const plan = schedule({ runs: [first, reordered, settled("run-2", 2, "running")] });
    assert.isTrue(plan.type === "pending" && plan.request.latestRunOrdinal === 3);
  });

  it("waits on the requesting run past a later-created run that ran before it", () => {
    assert.equal(
      evaluate(request, [first, reordered, settled("run-2", 2, "running")]).type,
      "wait",
    );
    const completed = settled("run-2", 2, "completed", "2026-10-01T00:00:02.000Z");
    assert.equal(evaluate(request, [first, reordered, completed]).type, "archive");
    // A run created after the request is new work.
    assert.deepEqual(
      evaluate(request, [first, reordered, completed, settled("run-4", 4, "running")]),
      { type: "cancel", detail: ARCHIVE_CANCEL_DETAIL.newWork },
    );
    // Requests recorded before the boundary keep comparing with the awaited run.
    const { latestRunOrdinal: _latest, ...legacy } = request;
    assert.equal(evaluate(legacy, [first, reordered, completed]).type, "cancel");
  });

  it("a withdrawn wake falls back past a run that settled before the archive", () => {
    const withdrawn = {
      ...run("run-4", 4, "cancelled", "2026-10-01T00:00:02.000Z"),
      startedAt: null,
      completedAt: at("2026-10-01T00:00:03.000Z"),
    };
    const wakeRequest = { ...request, runId: RunId.make("run-4") };
    assert.equal(
      evaluate(wakeRequest, [first, reordered, settled("run-2", 2, "waiting"), withdrawn]).type,
      "wait",
    );
    assert.equal(
      evaluate(wakeRequest, [
        first,
        reordered,
        settled("run-2", 2, "completed", "2026-10-01T00:00:04.000Z"),
        withdrawn,
      ]).type,
      "archive",
    );
  });

  it.effect("follows the restart continuation of the run that ran last", () =>
    Effect.gen(function* () {
      const outbox = {
        get: (effectId: string) =>
          Effect.succeed(
            effectId === "effect:restart-continuation:run-2"
              ? Option.some({ status: "pending" } as EffectOutbox.OrchestrationEffectV2)
              : Option.none(),
          ),
      };
      const interrupted = settled("run-2", 2, "interrupted", "2026-10-01T00:00:05.000Z");
      assert.isTrue(yield* restartContinuationPending(outbox, [first, reordered, interrupted]));
    }),
  );
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

const makeTestLayer = (settings: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  ThreadArchiveScheduler.layer.pipe(
    Layer.provideMerge(FakeWorktreeRemoval),
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
    Layer.provide(ServerConfigLayer),
    Layer.provide(ServerSettings.layerTest(settings)),
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
const TestLayer = makeTestLayer();

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "deferred-archive-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "deferred-archive-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

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

const completeRun = (threadId: ThreadId, target: OrchestrationV2Run, name: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.commitCommand({
      commandId: CommandId.make(name),
      threadId,
      commandType: "checkpoint.capture",
      acceptedAt: now,
      events: [
        {
          id: EventId.make(`${name}-run`),
          type: "run.updated",
          threadId,
          runId: target.id,
          occurredAt: now,
          payload: {
            ...target,
            status: "completed",
            startedAt: target.startedAt ?? now,
            completedAt: now,
          },
        },
      ],
      effects: [],
    });
  });

/**
 * A running parent turn with an archive pending after it, then the server's
 * delivery of its delegated tasks' results, queued behind the turn.
 */
const dispatchCompletionWake = (
  threadId: ThreadId,
  name: string,
  scheduler: ThreadArchiveScheduler.ThreadArchiveScheduler["Service"],
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const active = yield* sendMessage(threadId, name, { type: "start_immediately" });
    const pending = yield* scheduler.schedule({ threadId, afterTurn: true });
    assert.equal(pending.request?.runId, active.id);

    const wakeMessageId = MessageId.make(`${name}-wake`);
    const taskIds = [NodeId.make(`${name}-task`)];
    const now = yield* DateTime.now;
    const parent: OrchestrationV2Run = {
      ...active,
      status: "running",
      startedAt: now,
      delegatedCompletion: {
        disposition: "open",
        nextGeneration: 2,
        delivery: { generation: 1, messageId: wakeMessageId, taskIds },
      },
    };
    yield* eventSink.commitCommand({
      commandId: CommandId.make(`${name}-delegate`),
      threadId,
      commandType: "run.update",
      acceptedAt: now,
      events: [
        {
          id: EventId.make(`${name}-delegate-run`),
          type: "run.updated",
          threadId,
          runId: parent.id,
          occurredAt: now,
          payload: parent,
        },
        {
          id: EventId.make(`${name}-delegate-task`),
          type: "subagent.updated",
          threadId,
          runId: parent.id,
          nodeId: taskIds[0]!,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: taskIds[0]!,
            threadId,
            runId: parent.id,
            parentNodeId: NodeId.make(`${name}-root`),
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Delegated work.",
            title: null,
            model: null,
            completionWake: "always",
            completionDelivery: { state: "claimed", observedByRunId: null },
            status: "completed",
            result: "done",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        },
      ],
      effects: [],
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "agent",
      creationSource: "server",
      commandId: CommandId.make(`${name}-wake`),
      threadId,
      messageId: wakeMessageId,
      text: "Delegated tasks finished.",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
      delegatedCompletion: { parentRunId: parent.id, generation: 1, taskIds },
    });
    const wakeRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (candidate) => candidate.userMessageId === wakeMessageId,
    );
    assert.isDefined(wakeRun);
    assert.equal(wakeRun!.status, "queued");
    return { parent, wakeRun: wakeRun!, taskId: taskIds[0]! };
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

  it.effect("a subagent-completion wake moves the archive to its run, then archives", () =>
    Effect.gen(function* () {
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const threadId = yield* createThread("wake");
      const { parent, wakeRun } = yield* dispatchCompletionWake(threadId, "wake", scheduler);

      // The wake carries on the awaited work instead of cancelling the archive.
      const moved = yield* scheduler.status(threadId);
      assert.equal(moved.request?.status, "pending");
      assert.equal(moved.request?.runId, wakeRun.id);

      // The parent turn finishing is not enough: the archive waits for the wake run.
      yield* completeRun(threadId, parent, "wake-parent-complete");
      yield* scheduler.reconcilePending;
      assert.isNull((yield* threadState(threadId)).archivedAt);

      yield* completeRun(threadId, wakeRun, "wake-run-complete");
      yield* scheduler.reconcilePending;
      const thread = yield* threadState(threadId);
      assert.isNotNull(thread.archivedAt);
      assert.equal(thread.archiveRequest?.status, "completed");
      assert.equal(thread.archiveRequest?.runId, wakeRun.id);
    }),
  );

  it.effect("a wake withdrawn while queued leaves the archive waiting on the parent", () =>
    Effect.gen(function* () {
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* createThread("wake-withdrawn");
      const { parent, wakeRun, taskId } = yield* dispatchCompletionWake(
        threadId,
        "wake-withdrawn",
        scheduler,
      );
      assert.equal((yield* scheduler.status(threadId)).request?.runId, wakeRun.id);

      // The parent reads the result itself, so its queued wake is cancelled.
      yield* orchestrator.dispatch({
        type: "delegated_task.completion-delivery.acknowledge",
        commandId: CommandId.make("wake-withdrawn-ack"),
        parentThreadId: threadId,
        taskId,
        observedByRunId: parent.id,
      });
      const cancelled = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (candidate) => candidate.id === wakeRun.id,
      );
      assert.equal(cancelled?.status, "cancelled");

      yield* scheduler.reconcilePending;
      const waiting = yield* scheduler.status(threadId);
      assert.isNull(waiting.archivedAt);
      assert.equal(waiting.request?.status, "pending");

      // Complete the parent as projected now: withdrawing the wake released its delivery.
      const projectedParent = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (candidate) => candidate.id === parent.id,
      );
      assert.isNull(projectedParent?.delegatedCompletion?.delivery);
      yield* completeRun(threadId, projectedParent!, "wake-withdrawn-parent-complete");
      yield* scheduler.reconcilePending;
      const thread = yield* threadState(threadId);
      assert.isNotNull(thread.archivedAt);
      assert.equal(thread.archiveRequest?.status, "completed");
    }),
  );

  it.effect("a user's message still cancels an archive waiting through a wake", () =>
    Effect.gen(function* () {
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const threadId = yield* createThread("wake-user");
      yield* dispatchCompletionWake(threadId, "wake-user", scheduler);
      yield* sendMessage(threadId, "wake-user-followup", { type: "queue_after_active" });
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

  it.effect("a failed final checkpoint records an error and leaves the thread unarchived", () =>
    Effect.gen(function* () {
      yield* resetRemoval();
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = yield* createThread("checkpoint-failed");
      const active = yield* sendMessage(threadId, "checkpoint-failed", {
        type: "start_immediately",
      });
      yield* scheduler.schedule({ threadId, afterTurn: true, removeWorktree: true });

      const now = yield* DateTime.now;
      const checkpointId = CheckpointId.make("checkpoint-failed-cp");
      yield* eventSink.commitCommand({
        commandId: CommandId.make("checkpoint-failed-complete"),
        threadId,
        commandType: "checkpoint.capture",
        acceptedAt: now,
        events: [
          {
            id: EventId.make("checkpoint-failed-checkpoint"),
            type: "checkpoint.captured",
            threadId,
            runId: active.id,
            occurredAt: now,
            payload: {
              id: checkpointId,
              threadId,
              scopeId: CheckpointScopeId.make("checkpoint-failed-scope"),
              runId: active.id,
              nodeId: NodeId.make("checkpoint-failed-node"),
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: active.ordinal,
              ref: CheckpointRef.make("refs/t3/checkpoint-failed"),
              status: "error",
              files: [],
              capturedAt: now,
            },
          },
          {
            id: EventId.make("checkpoint-failed-run"),
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
      yield* scheduler.reconcilePending;
      yield* scheduler.reconcilePending;
      const thread = yield* threadState(threadId);
      assert.isNull(thread.archivedAt);
      assert.equal(thread.archiveRequest?.status, "error");
      assert.equal(thread.archiveRequest?.detail, ARCHIVE_CANCEL_DETAIL.checkpointFailed);
      assert.deepEqual(removal.removed, []);
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

  it.effect("marks a failed read after dispatch apart from an up-front refusal", () =>
    Effect.gen(function* () {
      yield* resetRemoval();
      const threads = yield* ThreadManagement.ThreadManagementService;
      // The archive dispatch commits; the status read that follows fails.
      const scheduler = yield* ThreadArchiveScheduler.make.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ...threads,
          getThreadRecords: (threadId) =>
            Effect.fail(new OrchestratorProjectionError({ threadId })),
        }),
        Effect.provide(NodeServices.layer),
      );
      const threadId = yield* createThread("status-read-fails");
      const failed = yield* scheduler.schedule({ threadId, afterTurn: false }).pipe(Effect.flip);
      assert.equal(failed.operation, "status");
      assert.isNotNull((yield* threadState(threadId)).archivedAt);

      yield* resetRemoval({ blocker: ArchiveWorktreeRemoval.WORKTREE_KEPT_DETAIL.shared });
      const refusedThreadId = yield* createThread("status-read-refused");
      const refused = yield* scheduler
        .schedule({ threadId: refusedThreadId, afterTurn: false, removeWorktree: true })
        .pipe(Effect.flip);
      assert.equal(refused.operation, "schedule");
      yield* resetRemoval();
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

  it.effect("reopening waits while the worktree removal holds its reservation", () =>
    Effect.gen(function* () {
      yield* resetRemoval();
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* createThread("remove-reserved");
      yield* scheduler.schedule({ threadId, afterTurn: false, removeWorktree: true });
      const unarchive = orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("remove-reserved-unarchive"),
        threadId,
      });
      const message = sendMessage(threadId, "remove-reserved", { type: "start_immediately" });

      yield* Effect.scoped(
        Effect.gen(function* () {
          assert.isTrue(
            yield* reserveWorkspace("/tmp/deferred-archive-remove-reserved", "removal"),
          );
          assert.equal((yield* Effect.flip(unarchive))._tag, "OrchestratorDispatchError");
          assert.equal((yield* Effect.flip(message))._tag, "OrchestratorDispatchError");
          const thread = yield* threadState(threadId);
          assert.isNotNull(thread.archivedAt);
          assert.equal(thread.archiveRequest?.status, "pending");
        }),
      ).pipe(Effect.provide(NodeServices.layer));

      // Released: the same commands now go through.
      yield* unarchive;
      const thread = yield* threadState(threadId);
      assert.isNull(thread.archivedAt);
      assert.equal(thread.archiveRequest?.detail, ARCHIVE_CANCEL_DETAIL.unarchived);
      yield* message;
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

  it.effect("archive tools read the archived thread for its own provider only", () =>
    Effect.gen(function* () {
      const threadId = yield* createThread("mcp-owner");
      const server = yield* McpServer.McpServer;
      const callAs = (providerInstanceId: ProviderInstanceId, name: string) =>
        server.callTool({ name, arguments: {} }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("deferred-archive-mcp"),
            requestNamespace: "deferred-archive-mcp-session",
            thread: {
              threadId,
              providerSessionId: "deferred-archive-mcp-session",
              providerInstanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"] as const),
            issuedAt: 1,
          }),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
        );

      // Idle, so the request archives the thread right away.
      const archived = yield* callAs(modelSelection.instanceId, "archive_thread");
      assert.isFalse(archived.isError);
      const status = yield* callAs(modelSelection.instanceId, "archive_thread_status");
      assert.isFalse(status.isError);
      assert.isNotNull((status.structuredContent as { archivedAt: string | null }).archivedAt);
      assert.deepInclude(
        (status.structuredContent as { request: OrchestrationV2ThreadArchiveRequest }).request,
        { status: "completed" },
      );

      const stranger = yield* callAs(
        ProviderInstanceId.make("deferred-archive-other"),
        "archive_thread_status",
      );
      // Effect returns a declared tool failure as JSON text, never as `structuredContent`.
      const strangerText = stranger.content[0];
      assert.isTrue(stranger.isError);
      assert.equal(strangerText?.type, "text");
      const strangerFailure = yield* decodeJsonText(
        strangerText?.type === "text" ? strangerText.text : "null",
      );
      assert.deepInclude(strangerFailure, {
        _tag: "OrchestratorMcpFailure",
        code: "parent_not_active",
      });
    }).pipe(
      Effect.provide(
        McpServer.toolkit(ArchiveToolkit).pipe(
          Layer.provide(ArchiveToolkitHandlersLive),
          Layer.provideMerge(McpServer.McpServer.layer),
        ),
      ),
      Effect.scoped,
    ),
  );
});

const ALL_EFFECT_TYPES = [
  ...EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
  ...EffectOutbox.REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS,
];

/**
 * Startup recovery as ProviderRuntimeRecoveryService commits it: the source
 * run settles, its other effects are retired, and a continuation is queued.
 */
const recoverWithContinuation = (
  threadId: ThreadId,
  source: OrchestrationV2Run,
  name: string,
  status: "cancelled" | "completed",
) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const commandId = CommandId.make(`${name}-recover`);
    yield* eventSink.commitCommand({
      commandId,
      threadId,
      commandType: "provider-runtime.reconcile",
      acceptedAt: now,
      events: [
        {
          id: EventId.make(`${name}-recover-run`),
          type: "run.updated",
          threadId,
          runId: source.id,
          occurredAt: now,
          payload: {
            ...source,
            status,
            queuePosition: null,
            startedAt: source.startedAt ?? now,
            completedAt: now,
          },
        },
      ],
      effects: [
        {
          id: `effect:restart-continuation:${source.id}`,
          commandId,
          threadId,
          request: { type: "provider-runtime.continue", sourceRunId: source.id },
        },
      ],
      cancelUnsettledEffects: {
        effectTypes: ALL_EFFECT_TYPES.filter((type) => type !== "provider-runtime.continue"),
        reason: "Server restarted.",
      },
    });
  });

const retireEffects = (threadId: ThreadId) =>
  Effect.flatMap(EffectOutbox.EffectOutboxV2, (outbox) =>
    outbox.cancelUnsettled({ threadId, effectTypes: ALL_EFFECT_TYPES, reason: "Test finished." }),
  );

it.layer(makeTestLayer({ continueThreadsAfterServerUpdate: true }))(
  "deferred archive across a restart continuation",
  (it) => {
    it.effect("holds until the continuation resumes the turn, then follows its run", () =>
      Effect.gen(function* () {
        const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = yield* createThread("restart-resume");
        const source = yield* sendMessage(threadId, "restart-resume", {
          type: "start_immediately",
        });
        yield* scheduler.schedule({ threadId, afterTurn: true });
        yield* recoverWithContinuation(threadId, source, "restart-resume", "cancelled");

        // Archive reconciliation can run before the effect worker resumes the agent.
        yield* scheduler.reconcilePending;
        const held = yield* scheduler.status(threadId);
        assert.equal(held.request?.status, "pending");
        assert.equal(held.request?.runId, source.id);

        assert.isTrue(yield* worker.runOnce);
        yield* scheduler.drain;
        const continuation = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (candidate) => candidate.restartContinuationOfRunId === source.id,
        );
        assert.isDefined(continuation);
        const moved = yield* scheduler.status(threadId);
        assert.equal(moved.request?.status, "pending");
        assert.equal(moved.request?.runId, continuation!.id);

        yield* completeRun(threadId, continuation!, "restart-resume-complete");
        yield* scheduler.reconcilePending;
        const thread = yield* threadState(threadId);
        assert.isNotNull(thread.archivedAt);
        assert.equal(thread.archiveRequest?.status, "completed");
        yield* retireEffects(threadId);
      }),
    );

    it.effect("archives once a declined continuation settles", () =>
      Effect.gen(function* () {
        const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = yield* createThread("restart-decline");
        const source = yield* sendMessage(threadId, "restart-decline", {
          type: "start_immediately",
        });
        yield* scheduler.schedule({ threadId, afterTurn: true });
        // The turn completed, but recovery queued a continuation for it.
        yield* recoverWithContinuation(threadId, source, "restart-decline", "completed");

        yield* scheduler.reconcilePending;
        assert.isNull((yield* threadState(threadId)).archivedAt);

        // Nothing to resume: the continuation settles without an event, and the
        // worker re-checks the archive itself.
        assert.isTrue(yield* worker.runOnce);
        yield* scheduler.drain;
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        const thread = yield* threadState(threadId);
        assert.isNotNull(thread.archivedAt);
        assert.equal(thread.archiveRequest?.status, "completed");
        yield* retireEffects(threadId);
      }),
    );
  },
);
