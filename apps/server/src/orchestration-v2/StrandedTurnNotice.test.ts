import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { priorTurnStrandedByRestart } from "./StrandedTurnNotice.ts";

const threadId = ThreadId.make("thread:stranded");
const instanceId = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread:stranded");
const sessionId = ProviderSessionId.make("session:stranded");

type Projection = OrchestrationV2ThreadProjection;
type Run = Projection["runs"][number];
type ProviderTurn = Projection["providerTurns"][number];

const attemptOf = (ordinal: number) => RunAttemptId.make(`attempt:${ordinal}`);

function run(ordinal: number, status: Run["status"], overrides: Partial<Run> = {}): Run {
  return {
    id: RunId.make(`run:${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-sonnet-4-6" },
    providerThreadId,
    userMessageId: MessageId.make(`message:${ordinal}`),
    activeAttemptId: attemptOf(ordinal),
    status,
    ...overrides,
  } as unknown as Run;
}

function providerTurn(ordinal: number, status: ProviderTurn["status"]): ProviderTurn {
  return {
    id: ProviderTurnId.make(`turn:${ordinal}`),
    providerThreadId,
    runAttemptId: attemptOf(ordinal),
    ordinal,
    status,
  } as unknown as ProviderTurn;
}

/** A thread whose first run is live at shutdown (`running`) or settled with work open (`waiting`). */
function liveProjection(status: "running" | "waiting"): Projection {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("stranded-project"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [run(1, status)],
    attempts: [
      {
        id: attemptOf(1),
        runId: RunId.make("run:1"),
        status: status === "running" ? "running" : "completed",
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        status: "active",
      },
    ],
    providerSessions: [{ id: sessionId, driver, providerInstanceId: instanceId, status: "ready" }],
    providerTurns: [providerTurn(1, status === "running" ? "running" : "completed")],
    runtimeRequests: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as Projection;
}

/** Runs real restart recovery and folds its run and provider-turn updates back in. */
const recover = Effect.fn("recover")(function* (projection: Projection) {
  const committed: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
  const recovery = yield* ProviderRuntimeRecovery.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) =>
            Effect.sync(() => {
              committed.push(input);
              return { committed: true, cancelledEffectCount: 0 } as never;
            }),
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );
  yield* recovery.reconcile("startup");
  const events = committed.flatMap((commit) => commit.events);
  return {
    ...projection,
    runs: projection.runs.map(
      (current) =>
        events.findLast(
          (event): event is Extract<typeof event, { type: "run.updated" }> =>
            event.type === "run.updated" && event.payload.id === current.id,
        )?.payload ?? current,
    ),
    providerTurns: projection.providerTurns.map(
      (current) =>
        events.findLast(
          (event): event is Extract<typeof event, { type: "provider-turn.updated" }> =>
            event.type === "provider-turn.updated" && event.payload.id === current.id,
        )?.payload ?? current,
    ),
  } as Projection;
});

const stranded = (
  runs: ReadonlyArray<Run>,
  providerTurns: ReadonlyArray<ProviderTurn>,
  next: Run,
  options: { compaction?: ReadonlyArray<number>; attemptIds?: ReadonlyArray<string> } = {},
) =>
  priorTurnStrandedByRestart({
    runs: [...runs, next],
    providerTurns,
    compactionMessageIds: new Set(
      (options.compaction ?? []).map((ordinal) => MessageId.make(`message:${ordinal}`)),
    ),
    run: next,
    runAttemptIds: options.attemptIds ?? [next.activeAttemptId!],
  });

it.effect("tells the turn after a restart cut a live turn, once", () =>
  Effect.gen(function* () {
    const recovered = yield* recover(liveProjection("running"));
    assert.equal(recovered.runs[0]?.status, "cancelled");
    assert.equal(recovered.providerTurns[0]?.status, "cancelled");
    assert.isTrue(stranded(recovered.runs, recovered.providerTurns, run(2, "starting")));
    // Once that turn reached the provider, the stranded turn is no longer the previous one.
    assert.isFalse(
      stranded(
        [...recovered.runs, run(2, "completed")],
        [...recovered.providerTurns, providerTurn(2, "completed")],
        run(3, "starting"),
      ),
    );
  }),
);

it.effect("does not tell a turn whose predecessor had settled before the restart", () =>
  Effect.gen(function* () {
    // Only background work was lost; RestartBackgroundNote covers that.
    const recovered = yield* recover(liveProjection("waiting"));
    assert.equal(recovered.runs[0]?.status, "cancelled");
    assert.equal(recovered.providerTurns[0]?.status, "completed");
    assert.isFalse(stranded(recovered.runs, recovered.providerTurns, run(2, "starting")));
  }),
);

it("does not tell a turn after the user stopped the previous one", () => {
  assert.isFalse(
    stranded([run(1, "interrupted")], [providerTurn(1, "interrupted")], run(2, "starting")),
  );
});

it("skips compactions and steer replacements, and stays on its provider thread", () => {
  const strandedRuns = [run(1, "cancelled")];
  const strandedTurns = [providerTurn(1, "cancelled")];
  // A compaction neither carries the notice nor counts as delivering it.
  assert.isFalse(stranded(strandedRuns, strandedTurns, run(2, "starting"), { compaction: [2] }));
  assert.isTrue(
    stranded(
      [...strandedRuns, run(2, "completed")],
      [...strandedTurns, providerTurn(2, "completed")],
      run(3, "starting"),
      { compaction: [2] },
    ),
  );
  // An earlier attempt of the same run already delivered it.
  assert.isFalse(
    stranded(
      strandedRuns,
      [
        ...strandedTurns,
        {
          ...providerTurn(2, "interrupted"),
          runAttemptId: RunAttemptId.make("attempt:2-first"),
        },
      ],
      run(2, "starting"),
      { attemptIds: ["attempt:2-first", "attempt:2"] },
    ),
  );
  // After a provider switch the new provider thread never saw the stranded turn.
  assert.isFalse(
    stranded(
      strandedRuns,
      strandedTurns,
      run(2, "starting", { providerThreadId: ProviderThreadId.make("provider-thread:other") }),
    ),
  );
});
