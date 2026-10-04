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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
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

it.effect("releases the messages queued at a turn's start into it as steers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("queue-batch-release");
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const started: Array<ProviderAdapterV2TurnInput> = [];
      const steered: Array<string> = [];
      const leaderStarted = yield* Deferred.make<void>();
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
                  // The test reports the queued leader's turn as running itself,
                  // so it can submit while that turn is still starting.
                  if (started.length > 1) {
                    yield* Deferred.succeed(leaderStarted, undefined);
                    return;
                  }
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
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:queue-batch-release");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const send = (id: string, dispatchMode: "start_immediately" | "queue_after_active") =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            dispatchMode: { type: dispatchMode },
            createdBy: "user",
            creationSource: "web",
          });

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:queue-batch-release"),
          title: "Batch release",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const firstRunning = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* send("active", "start_immediately");
        yield* worker.drain();
        yield* Fiber.join(firstRunning);

        yield* send("first", "queue_after_active");
        yield* send("second", "queue_after_active");
        yield* send("third", "queue_after_active");
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs
          .filter((run) => run.status === "queued")
          .toSorted((left, right) => left.ordinal - right.ordinal);
        assert.equal(queued.length, 3);
        const [leader, second, third] = queued;

        // The active turn ends: the first queued message starts the next turn.
        const leaderStarting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === leader!.id &&
            event.payload.status === "starting",
        );
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
        yield* worker.drain();
        yield* Fiber.join(leaderStarting);
        yield* worker.drain();
        yield* Deferred.await(leaderStarted);

        const batched = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          batched.runs
            .filter((run) => run.queueBatchLeaderRunId === leader!.id)
            .map((run) => run.id),
          [second!.id, third!.id],
        );

        // Submitted after the batch formed, so it waits for its own turn.
        yield* send("late", "queue_after_active");

        const released = yield* watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === third!.userMessageId,
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: providerTurnFor(started[1]!, yield* DateTime.now),
        });
        yield* Fiber.join(released);
        yield* worker.drain();

        assert.equal(started.length, 2);
        assert.equal(started[1]!.runId, leader!.id);
        assert.deepEqual(steered, ["second", "third"]);
        const final = yield* orchestrator.getThreadProjection(threadId);
        for (const member of [second!, third!]) {
          assert.equal(final.runs.find((run) => run.id === member.id)?.status, "cancelled");
          assert.equal(
            final.messages.find((message) => message.id === member.userMessageId)?.runId,
            leader!.id,
          );
        }
        const late = final.runs.find((run) => run.userMessageId === MessageId.make("message:late"));
        assert.equal(late?.status, "queued");
        assert.isUndefined(late?.queueBatchLeaderRunId);
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "queue-batch-release" },
            ProviderAdapterRegistry.makeSingleLayer(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  ),
);
