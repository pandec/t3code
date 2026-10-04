// Fork regression (DECISIONS 5.5): a provider that rejects a steer fails only
// the steer effect. The turn and its session keep running, and a Stop that
// lands while the steer is in flight still ends the turn as interrupted.
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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterSteerRunError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect.each([{ stop: false }, { stop: true }])(
  "a rejected steer fails only the steer effect (concurrent Stop: $stop)",
  ({ stop }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `steer-rejection-${stop ? "stop" : "no-stop"}`;
        const cwd = yield* checkpointWorkspace(name);
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const started: ProviderAdapterV2TurnInput[] = [];
        const steerEntered = yield* Deferred.make<void>();
        const rejectSteer = yield* Deferred.make<void>();
        let steerCalls = 0;
        let interruptCalls = 0;
        const capabilities = {
          ...CodexProviderCapabilitiesV2,
          turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: true },
        };
        const adapter: ProviderAdapterV2Shape = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(capabilities),
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
                  capabilities,
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
                      providerTurn: {
                        id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: {
                          driver,
                          nativeId: `native:${turn.attemptId}`,
                          strength: "strong",
                        },
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                  }),
                // The first delivery parks until the test rejects it; retries
                // are rejected at once.
                steerTurn: (turn) =>
                  Effect.gen(function* () {
                    steerCalls += 1;
                    if (steerCalls === 1) {
                      yield* Deferred.succeed(steerEntered, undefined);
                      yield* Deferred.await(rejectSteer);
                    }
                    return yield* new ProviderAdapterSteerRunError({
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId: turn.providerTurnId,
                      cause: "steer rejected by the provider",
                    });
                  }),
                interruptTurn: ({ providerThread, providerTurnId }) =>
                  Effect.gen(function* () {
                    interruptCalls += 1;
                    yield* Queue.offer(events, {
                      type: "turn.terminal",
                      driver,
                      providerThreadId: providerThread.id,
                      providerTurnId,
                      runOrdinal: started[0]!.runOrdinal,
                      status: "interrupted",
                      failure: null,
                      threadDisposition: "reusable",
                    });
                  }),
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
          const threadId = ThreadId.make(`thread:${name}`);
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          const send = (id: string, text: string) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(id),
              threadId,
              messageId: MessageId.make(`message:${id}`),
              text,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            title: "Rejected steer",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          yield* send("first", "first");
          yield* worker.drain();
          yield* Fiber.join(running);
          const first = started[0]!;

          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("steer"),
            threadId,
            messageId: MessageId.make("message:steer"),
            text: "steer",
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId: first.runId },
            createdBy: "user",
            creationSource: "web",
          });
          const delivery = yield* worker.runOnce.pipe(Effect.forkScoped);
          yield* Deferred.await(steerEntered);
          if (stop) {
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("stop"),
              threadId,
              runId: first.runId,
            });
          }
          yield* Deferred.succeed(rejectSteer, undefined);
          assert.isTrue(yield* Fiber.join(delivery));

          // The rejection failed only the steer effect: the turn still runs.
          const afterRejection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(steerCalls, 1);
          assert.equal(
            afterRejection.runs.find((run) => run.id === first.runId)?.status,
            "running",
          );
          assert.equal(afterRejection.providerTurns[0]?.status, "running");
          assert.equal(started.length, 1);

          const turn = afterRejection.providerTurns[0]!;
          if (stop) {
            const interrupted = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === first.runId &&
                event.payload.status === "interrupted",
            );
            yield* worker.drain();
            yield* Fiber.join(interrupted);
            assert.equal(interruptCalls, 1);
          } else {
            const settled = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === first.runId &&
                event.payload.status === "waiting",
            );
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: first.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(settled);
          }

          // Let the outbox run the steer's retries.
          for (let retry = 0; retry < 5; retry++) {
            yield* TestClock.adjust("30 seconds");
            yield* worker.drain();
          }
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();

          if (stop) {
            // Stop wins: the rejected steer does not start a new turn, and the
            // run ends interrupted rather than failed.
            const stopped = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(stopped.runs.find((run) => run.id === first.runId)?.status, "interrupted");
            assert.equal(started.length, 1);
          } else {
            // The turn ended, so the steer is redelivered as a follow-up turn.
            assert.equal(started.length, 2);
            assert.equal(started[1]?.message.messageId, MessageId.make("message:steer"));
          }

          // The session survived: the next message starts a turn on it.
          const turnsBefore = started.length;
          if (!stop) {
            const followUp = started[1]!;
            const followUpTurn = (yield* orchestrator.getThreadProjection(
              threadId,
            )).providerTurns.find((candidate) => candidate.runAttemptId === followUp.attemptId)!;
            const followUpSettled = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === followUp.runId &&
                event.payload.status === "waiting",
            );
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: followUpTurn.providerThreadId,
              providerTurnId: followUpTurn.id,
              runOrdinal: followUp.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(followUpSettled);
          }
          yield* send("next", "next");
          yield* worker.drain();
          assert.equal(started.length, turnsBefore + 1);
          assert.equal(
            started.at(-1)?.providerThread.providerSessionId,
            first.providerThread.providerSessionId,
          );
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              { name },
              ProviderAdapterRegistry.makeSingleLayer(adapter),
              { runEffectWorker: false },
            ),
          ),
        );
      }),
    ),
);
