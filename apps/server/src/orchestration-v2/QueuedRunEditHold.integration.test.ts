import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  QUEUED_RUN_EDIT_HOLD_LEASE_MS,
  ThreadId,
  type RunId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

const providerTurnFor = (
  turn: ProviderAdapterV2TurnInput,
  now: DateTime.Utc,
): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
  providerThreadId: turn.providerThread.id,
  nodeId: turn.rootNodeId,
  runAttemptId: turn.attemptId,
  nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
  ordinal: turn.providerTurnOrdinal,
  status: "running",
  startedAt: now,
  completedAt: null,
});

/** A fake Codex adapter whose turns run until the test ends them. */
const makeHarness = (name: string) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const started: Array<ProviderAdapterV2TurnInput> = [];
    const steered: Array<string> = [];
    const adapter: ProviderAdapterV2Shape = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd,
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: ({ threadId }) =>
              Effect.succeed({
                id: ProviderThreadId.make(`provider-thread:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) =>
              Effect.gen(function* () {
                started.push(turn);
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: providerTurnFor(turn, yield* DateTime.now),
                });
              }),
            steerTurn: (turn) =>
              Effect.sync(() => {
                steered.push(turn.message.text);
              }),
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    const layer = makeOrchestratorV2ReplayLayerWithRegistry(
      { name },
      ProviderAdapterRegistry.makeSingleLayer(adapter),
      { runEffectWorker: false },
    );
    return { cwd, events, started, steered, layer };
  });

const scenario = (name: string) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(name);
    const threadId = ThreadId.make(`thread:${name}`);
    const setup = Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((collected) => Array.from(collected)[0]!),
          Effect.forkScoped,
        );
      const send = (id: string, mode: "start" | "queue") =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(`message:${id}`),
          text: id,
          attachments: [],
          dispatchMode: { type: mode === "queue" ? "queue_after_active" : "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
      const hold = (id: string, runId: RunId, held: boolean) =>
        orchestrator.dispatch({
          type: "queued-run.edit-hold",
          commandId: CommandId.make(id),
          threadId,
          runId,
          held,
        });
      // Ends the first (active) turn so the queue would normally start.
      const endActiveTurn = Effect.gen(function* () {
        const activeTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const activeEnded = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === harness.started[0]!.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(harness.events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...activeTurn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(harness.events, {
          type: "turn.terminal",
          driver,
          providerThreadId: activeTurn.providerThreadId,
          providerTurnId: activeTurn.id,
          runOrdinal: harness.started[0]!.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(activeEnded);
        yield* worker.drain();
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make(`project:${name}`),
        title: "Queued message edit hold",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: harness.cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const firstRunning = yield* watch(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* send("active", "start");
      yield* worker.drain();
      yield* Fiber.join(firstRunning);
      return { orchestrator, worker, watch, send, hold, endActiveTurn };
    });
    return { ...harness, threadId, setup };
  });

it.effect(
  "keeps a queued message from starting while it is edited, then starts the saved edit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, threadId, setup, layer } = yield* scenario("edit-hold-release");
        yield* Effect.gen(function* () {
          const { orchestrator, worker, watch, send, hold, endActiveTurn } = yield* setup;
          yield* send("queued", "queue");
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.status === "queued",
          )!;
          yield* hold("hold", queued.id, true);
          assert.isDefined(
            (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.id === queued.id,
            )?.editHeldUntil,
          );

          yield* endActiveTurn;
          // The turn ended, but the edited message keeps waiting and cannot be steered.
          assert.equal(started.length, 1);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.id === queued.id,
            )?.status,
            "queued",
          );
          const promoted = yield* orchestrator
            .dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("promote-held"),
              threadId,
              queuedRunId: queued.id,
              targetRunId: started[0]!.runId,
            })
            .pipe(Effect.flip);
          assert.equal(promoted._tag, "OrchestratorDispatchError");

          yield* orchestrator.dispatch({
            type: "queued-run.edit",
            commandId: CommandId.make("save-edit"),
            threadId,
            runId: queued.id,
            text: "edited",
          });
          const queuedStarting = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === queued.id &&
              event.payload.status === "starting",
          );
          yield* hold("release", queued.id, false);
          yield* Fiber.join(queuedStarting);
          yield* worker.drain();

          assert.equal(started.length, 2);
          assert.equal(started[1]!.runId, queued.id);
          assert.equal(started[1]!.message.text, "edited");
          assert.deepEqual(steered, []);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("resumes the queue once an abandoned edit hold lapses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, threadId, setup, layer } = yield* scenario("edit-hold-lapse");
      yield* Effect.gen(function* () {
        const { orchestrator, worker, watch, send, hold, endActiveTurn } = yield* setup;
        yield* send("queued", "queue");
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        const heldAt = yield* DateTime.now;
        yield* hold("hold", queued.id, true);
        yield* endActiveTurn;
        assert.equal(started.length, 1);

        const queuedStarting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === queued.id &&
            event.payload.status === "starting",
        );
        yield* TestClock.adjust(Duration.millis(QUEUED_RUN_EDIT_HOLD_LEASE_MS));
        const startingEvent = yield* Fiber.join(queuedStarting);
        yield* worker.drain();

        assert.isFalse(
          DateTime.isLessThan(
            startingEvent.occurredAt,
            DateTime.add(heldAt, { milliseconds: QUEUED_RUN_EDIT_HOLD_LEASE_MS }),
          ),
        );
        assert.equal(started.length, 2);
        assert.equal(started[1]!.runId, queued.id);
        assert.isUndefined(
          (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === queued.id,
          )?.editHeldUntil,
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);
