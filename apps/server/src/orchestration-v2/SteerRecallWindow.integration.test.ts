import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
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
import {
  ProviderAdapterCapabilitiesError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const GRACE_MS = 5_000;

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
    // Runs once in place of the next capabilities read, e.g. to fail a queued start.
    const nextCapabilities: {
      current: Effect.Effect<void, ProviderAdapterCapabilitiesError> | null;
    } = { current: null };
    const adapter: ProviderAdapterV2Shape = {
      instanceId,
      driver,
      getCapabilities: () => {
        const hook = nextCapabilities.current;
        nextCapabilities.current = null;
        return (hook ?? Effect.void).pipe(Effect.as(CodexProviderCapabilitiesV2));
      },
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
            // Like a real provider, an interrupted turn reports its terminal.
            interruptTurn: ({ providerThread, providerTurnId }) =>
              Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: providerThread.id,
                providerTurnId,
                runOrdinal: started.find(
                  (turn) =>
                    ProviderTurnId.make(`provider-turn:${turn.attemptId}`) === providerTurnId,
                )!.runOrdinal,
                status: "interrupted",
                failure: null,
                threadDisposition: "reusable",
              }).pipe(Effect.asVoid),
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    const layer = ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerSingle(adapter),
      { runEffectWorker: false },
    );
    return { cwd, events, started, steered, nextCapabilities, layer };
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
      const send = (id: string, mode: "start" | "steer" | "queue") =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(`message:${id}`),
          text: id,
          attachments: [],
          dispatchMode: { type: mode === "queue" ? "queue_after_active" : "start_immediately" },
          ...(mode === "steer"
            ? { deliveryIntent: "steer" as const, steerGraceWindowMs: GRACE_MS }
            : {}),
          createdBy: "user",
          creationSource: "web",
        });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make(`project:${name}`),
        title: "Steer recall window",
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
      return { orchestrator, worker, watch, send };
    });
    return { ...harness, threadId, setup };
  });

it.effect("holds a steer for its recall window, then steers its latest text", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steered, started, threadId, setup, layer } = yield* scenario("steer-recall-edit");
      yield* Effect.gen(function* () {
        const { orchestrator, worker, watch, send } = yield* setup;
        const submittedAt = yield* DateTime.now;
        yield* send("typo", "steer");
        yield* send("recalled", "steer");

        const held = (yield* orchestrator.getThreadProjection(threadId)).runs.filter(
          (run) => run.status === "queued",
        );
        assert.equal(held.length, 2);
        const [typo, recalled] = held.toSorted((left, right) => left.ordinal - right.ordinal);
        const deadline = DateTime.add(submittedAt, { milliseconds: GRACE_MS });
        assert.isTrue(DateTime.Equivalence(typo!.steerDeadlineAt!, deadline));
        assert.deepEqual(steered, []);

        // Inside the window the held steer is an ordinary queued run.
        yield* orchestrator.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("edit-typo"),
          threadId,
          runId: typo!.id,
          text: "fixed",
        });
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("recall"),
          threadId,
          runId: recalled!.id,
        });

        const delivered = yield* watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === typo!.userMessageId,
        );
        yield* TestClock.adjust(Duration.millis(GRACE_MS));
        const deliveredEvent = yield* Fiber.join(delivered);
        yield* worker.drain();

        assert.isFalse(DateTime.isLessThan(deliveredEvent.occurredAt, deadline));
        // Released by its window, it is still the user's steer, not a promoted queued message.
        assert.equal(
          deliveredEvent.type === "turn-item.updated" &&
            deliveredEvent.payload.type === "user_message"
            ? deliveredEvent.payload.inputIntent
            : null,
          "steer",
        );
        assert.deepEqual(steered, ["fixed"]);
        assert.equal(started.length, 1);
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(final.runs.find((run) => run.id === typo!.id)?.status, "cancelled");
        assert.equal(
          final.messages.find((message) => message.id === typo!.userMessageId)?.runId,
          started[0]!.runId,
        );
        assert.equal(final.runs.find((run) => run.id === recalled!.id)?.status, "cancelled");
        assert.isFalse(
          final.messages.some(
            (message) => message.text === "recalled" && message.runId === started[0]!.runId,
          ),
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("starts a held steer as its own turn when the turn ends inside the window", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, threadId, setup, layer } =
        yield* scenario("steer-recall-idle");
      yield* Effect.gen(function* () {
        const { orchestrator, worker, watch, send } = yield* setup;
        const submittedAt = yield* DateTime.now;
        yield* send("late-steer", "steer");
        const held = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        );
        assert.isDefined(held?.steerDeadlineAt);

        const active = yield* orchestrator.getThreadProjection(threadId);
        const activeTurn = active.providerTurns[0]!;
        const activeEnded = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === started[0]!.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...activeTurn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: activeTurn.providerThreadId,
          providerTurnId: activeTurn.id,
          runOrdinal: started[0]!.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(activeEnded);

        const heldStarting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === held!.id &&
            event.payload.status === "starting",
        );
        yield* worker.drain();
        yield* TestClock.adjust(Duration.millis(GRACE_MS));
        const startingEvent = yield* Fiber.join(heldStarting);
        yield* worker.drain();

        // It waited out its window even though the thread went idle first.
        assert.isFalse(
          DateTime.isLessThan(
            startingEvent.occurredAt,
            DateTime.add(submittedAt, { milliseconds: GRACE_MS }),
          ),
        );
        assert.deepEqual(steered, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]!.runId, held!.id);
        const startedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === held!.id,
        );
        assert.isUndefined(startedRun?.steerDeadlineAt);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("lets the next queued turn start ahead of a held steer, then steers into it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, threadId, setup, layer } =
        yield* scenario("steer-recall-next-turn");
      yield* Effect.gen(function* () {
        const { orchestrator, worker, watch, send } = yield* setup;
        const submittedAt = yield* DateTime.now;
        yield* send("held-steer", "steer");
        yield* send("queued", "queue");
        const queuedRuns = (yield* orchestrator.getThreadProjection(threadId)).runs
          .filter((run) => run.status === "queued")
          .toSorted((left, right) => left.ordinal - right.ordinal);
        const [heldSteer, queued] = queuedRuns;
        assert.isDefined(heldSteer?.steerDeadlineAt);
        assert.isUndefined(queued?.steerDeadlineAt);

        const activeTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const queuedRunning = yield* watch(
          (event) =>
            event.type === "provider-turn.updated" &&
            event.payload.status === "running" &&
            event.payload.runAttemptId === queued!.activeAttemptId,
        );
        const activeEnded = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === started[0]!.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...activeTurn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: activeTurn.providerThreadId,
          providerTurnId: activeTurn.id,
          runOrdinal: started[0]!.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(activeEnded);
        yield* worker.drain();
        const runningEvent = yield* Fiber.join(queuedRunning);
        const deadline = DateTime.add(submittedAt, { milliseconds: GRACE_MS });
        // The later message started inside the held steer's window, without it.
        assert.isTrue(DateTime.isLessThan(runningEvent.occurredAt, deadline));
        assert.equal(started[1]!.runId, queued!.id);
        assert.isUndefined(
          (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === heldSteer!.id,
          )?.queueBatchLeaderRunId,
        );

        const delivered = yield* watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === heldSteer!.userMessageId,
        );
        yield* TestClock.adjust(Duration.millis(GRACE_MS));
        const deliveredEvent = yield* Fiber.join(delivered);
        yield* worker.drain();

        assert.equal(
          deliveredEvent.type === "turn-item.updated" &&
            deliveredEvent.payload.type === "user_message"
            ? deliveredEvent.payload.inputIntent
            : null,
          "steer",
        );
        assert.deepEqual(steered, ["held-steer"]);
        assert.equal(started.length, 2);
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          final.messages.find((message) => message.id === heldSteer!.userMessageId)?.runId,
          queued!.id,
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect(
  "fails the queued run whose start failed, not a steer whose window lapsed meanwhile",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, started, nextCapabilities, threadId, setup, layer } = yield* scenario(
          "steer-recall-start-failure",
        );
        yield* Effect.gen(function* () {
          const { orchestrator, worker, watch, send } = yield* setup;
          yield* send("held-steer", "steer");
          yield* send("queued", "queue");
          const [heldSteer, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs
            .filter((run) => run.status === "queued")
            .toSorted((left, right) => left.ordinal - right.ordinal);

          // The queued message's start outlasts the steer's window, then fails.
          nextCapabilities.current = TestClock.adjust(Duration.millis(GRACE_MS)).pipe(
            Effect.andThen(Effect.fail(new ProviderAdapterCapabilitiesError({ driver }))),
          );
          const firstFailure = yield* watch(
            (event) => event.type === "run.updated" && event.payload.status === "failed",
          );
          const activeEnded = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === started[0]!.runId &&
              event.payload.status === "waiting",
          );
          const activeTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...activeTurn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: activeTurn.providerThreadId,
            providerTurnId: activeTurn.id,
            runOrdinal: started[0]!.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(activeEnded);
          yield* worker.drain();
          const failed = yield* Fiber.join(firstFailure);
          yield* worker.drain();

          assert.equal(failed.type === "run.updated" ? failed.payload.id : null, queued!.id);
          assert.notEqual(
            (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.id === heldSteer!.id,
            )?.status,
            "failed",
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("steers into a new turn while older queued messages stay held after a stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, threadId, setup, layer } =
        yield* scenario("steer-recall-held-queue");
      yield* Effect.gen(function* () {
        const { orchestrator, worker, watch, send } = yield* setup;
        yield* send("old-queued", "queue");
        const oldQueued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;

        // Stop holds the queue; the stopped turn reports its end.
        const activeTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const activeEnded = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === started[0]!.runId &&
            event.payload.status === "interrupted",
        );
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: started[0]!.runId,
          holdQueue: true,
        });
        yield* worker.drain();
        yield* Fiber.join(activeEnded);
        yield* worker.drain();

        const nextRunning = yield* watch(
          (event) =>
            event.type === "provider-turn.updated" &&
            event.payload.status === "running" &&
            event.payload.runAttemptId !== activeTurn.runAttemptId,
        );
        yield* send("next", "start");
        yield* worker.drain();
        yield* Fiber.join(nextRunning);
        assert.equal(started.length, 2);

        yield* send("windowed-steer", "steer");
        const steer = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued" && run.steerDeadlineAt !== undefined,
        );
        assert.isDefined(steer);
        assert.notEqual(steer!.queueHeld, true);

        const delivered = yield* watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === steer!.userMessageId,
        );
        yield* TestClock.adjust(Duration.millis(GRACE_MS));
        yield* Fiber.join(delivered);
        yield* worker.drain();

        assert.deepEqual(steered, ["windowed-steer"]);
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          final.messages.find((message) => message.id === steer!.userMessageId)?.runId,
          started[1]!.runId,
        );
        const old = final.runs.find((run) => run.id === oldQueued.id);
        assert.equal(old?.status, "queued");
        assert.isTrue(old?.queueHeld);
      }).pipe(Effect.provide(layer));
    }),
  ),
);
