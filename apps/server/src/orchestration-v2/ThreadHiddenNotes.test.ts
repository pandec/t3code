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
import type {
  ProviderAdapterV2,
  ProviderAdapterV2Event,
  ProviderAdapterV2SteerInput,
  ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadHiddenNotes from "./ThreadHiddenNotes.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect("pending hidden notes reach the provider with the next turn or steer, once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("hidden-notes");
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const started: ProviderAdapterV2TurnInput[] = [];
      const steered: ProviderAdapterV2SteerInput[] = [];
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: true },
      };
      const adapter: ProviderAdapterV2["Service"] = {
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
      const database = SqlitePersistence.layerMemory;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const notes = yield* ThreadHiddenNotes.ThreadHiddenNotes;
        const threadId = ThreadId.make("thread:hidden-notes");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:hidden-notes"),
          title: "Hidden notes",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* notes.put({ threadId, kind: "test", text: "This thread runs in sp-lab-1." });
        // Bound to another checkout: a thread launched elsewhere never hears it.
        yield* notes.put({
          threadId,
          kind: "elsewhere",
          text: "This thread runs in sp-lab-2.",
          worktreePath: "/somewhere/else",
        });

        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:first"),
          threadId,
          messageId: MessageId.make("message:first"),
          text: "fix the parser",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);

        assert.equal(
          started[0]!.message.text,
          [
            "<system-reminder>",
            "This thread runs in sp-lab-1.",
            "</system-reminder>",
            "",
            "User message:",
            "fix the parser",
          ].join("\n"),
        );
        // Delivered once, the misplaced note dropped, and the transcript keeps what the user sent.
        assert.deepEqual(yield* notes.pending(threadId, { worktreePath: "/somewhere/else" }), []);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          projection.messages.find((message) => message.id === "message:first")?.text,
          "fix the parser",
        );

        // A steer is the user's next message too.
        yield* notes.put({ threadId, kind: "test", text: "`sp-labs up sp-lab-1` failed: boom" });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "also the lexer",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        assert.equal(
          steered[0]?.message.text,
          [
            "<system-reminder>",
            "`sp-labs up sp-lab-1` failed: boom",
            "</system-reminder>",
            "",
            "User message:",
            "also the lexer",
          ].join("\n"),
        );
        assert.deepEqual(yield* notes.pending(threadId, null), []);
      }).pipe(
        Effect.provide(
          Layer.merge(
            ProviderReplayHarness.layerWithRegistry(
              { name: "hidden-notes" },
              ProviderAdapterRegistry.layerSingle(adapter),
              { runEffectWorker: false, databaseLayer: database },
            ),
            ThreadHiddenNotes.layer.pipe(Layer.provide(database)),
          ),
        ),
      );
    }),
  ),
);
