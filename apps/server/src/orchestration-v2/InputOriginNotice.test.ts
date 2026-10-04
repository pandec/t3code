import { assert, describe, it } from "@effect/vitest";
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
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import { withInputOriginNotice } from "./InputOriginNotice.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2SteerInput,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const NOTICE_TAG = "<voice_transcription_notice>";

describe("withInputOriginNotice", () => {
  it("cautions providers about dictated text and leaves everything else unchanged", () => {
    assert.equal(withInputOriginNotice("Fix the parser", undefined), "Fix the parser");
    const dictated = withInputOriginNotice("Fix the parser  ", "voice-transcription");
    assert.isTrue(dictated.startsWith("Fix the parser\n\n" + NOTICE_TAG));
    // Attachment-only turns and slash commands must not turn into notice-only prompts.
    assert.equal(withInputOriginNotice("  ", "voice-transcription"), "  ");
    assert.equal(withInputOriginNotice("/compact", "voice-transcription"), "/compact");
  });
});

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect("carries voice origin through send, steer, queue and queued edits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("voice-origin");
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const started: ProviderAdapterV2TurnInput[] = [];
      const steered: ProviderAdapterV2SteerInput[] = [];
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
              steerTurn: (turn) => Effect.sync(() => void steered.push(turn)),
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
        const threadId = ThreadId.make("thread:voice-origin");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const sendVoice = (
          id: string,
          text: string,
          dispatchMode:
            | { readonly type: "start_immediately" }
            | { readonly type: "queue_after_active" }
            | { readonly type: "steer_active"; readonly targetRunId: (typeof started)[0]["runId"] },
        ) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`command:${id}`),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text,
            inputOrigin: "voice-transcription",
            attachments: [],
            dispatchMode,
            createdBy: "user",
            creationSource: "mobile",
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:voice-origin"),
          title: "Voice origin",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "mobile",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* sendVoice("first", "fix the parser", { type: "start_immediately" });
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;
        assert.isTrue(first.message.text.startsWith("fix the parser\n\n" + NOTICE_TAG));

        // The stored transcript keeps only the user's words plus the origin.
        const afterSend = yield* orchestrator.getThreadProjection(threadId);
        const firstMessage = afterSend.messages.find((m) => m.id === "message:first");
        assert.equal(firstMessage?.text, "fix the parser");
        assert.equal(firstMessage?.inputOrigin, "voice-transcription");
        const firstItem = afterSend.turnItems.find(
          (item) => item.type === "user_message" && item.messageId === "message:first",
        );
        assert.equal(
          firstItem?.type === "user_message" ? firstItem.inputOrigin : null,
          "voice-transcription",
        );

        yield* sendVoice("steer", "also the lexer", {
          type: "steer_active",
          targetRunId: first.runId,
        });
        yield* sendVoice("queued", "then run tests", { type: "queue_after_active" });
        yield* worker.drain();
        assert.isTrue(steered[0]?.message.text.startsWith("also the lexer\n\n" + NOTICE_TAG));

        const queued = yield* orchestrator.getThreadProjection(threadId);
        const queuedRun = queued.runs.find((run) => run.status === "queued");
        assert.isDefined(queuedRun);
        // An edit that does not name an origin keeps the dictated one.
        yield* orchestrator.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("command:edit"),
          threadId,
          runId: queuedRun.id,
          text: "then run all tests",
        });

        const completed = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const turn = projection.providerTurns[0]!;
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
        yield* Fiber.join(completed);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        assert.equal(started.length, 2);
        assert.isTrue(started[1]!.message.text.startsWith("then run all tests\n\n" + NOTICE_TAG));
        const final = yield* orchestrator.getThreadProjection(threadId);
        const queuedMessage = final.messages.find((m) => m.id === "message:queued");
        assert.equal(queuedMessage?.text, "then run all tests");
        assert.equal(queuedMessage?.inputOrigin, "voice-transcription");
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "voice-origin" },
            ProviderAdapterRegistry.makeSingleLayer(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  ),
);
