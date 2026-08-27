import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MessageSpeechAttachment,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerActivation } from "../../serverActivation.ts";
import { MessageSpeech, MessageSpeechError } from "../../voice/MessageSpeech.ts";
import { MessageSpeechReactor } from "../Services/MessageSpeechReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../Services/RuntimeReceiptBus.ts";
import { MessageSpeechReactorLive } from "./MessageSpeechReactor.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const speech = (messageId: MessageId): MessageSpeechAttachment => ({
  speechId: `speech:${messageId}`,
  transcript: `Speech for ${messageId}`,
  mimeType: "audio/mpeg",
  sizeBytes: 123,
  sourceTextHash: "source-hash",
  scriptRecipeHash: "recipe-hash",
  voiceId: "voice-1",
  ttsModel: "model-1",
  origin: "user",
  createdAt: NOW,
});

function readModel(
  requests: ReadonlyArray<{
    readonly messageId: MessageId;
    readonly requestId: CommandId;
  }>,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: requests.map(({ messageId, requestId }) => ({
          id: messageId,
          role: "assistant" as const,
          text: `Message ${messageId}`,
          speechRequest: { requestId, startedAt: NOW },
          turnId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        })),
        completedTurnAssistantMessageIds: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const requestedEvent = (messageId: MessageId, requestId: CommandId): OrchestrationEvent => ({
  sequence: 1,
  eventId: EventId.make(`event:${messageId}`),
  type: "thread.message-speech-requested",
  aggregateKind: "thread",
  aggregateId: ThreadId.make("thread-1"),
  occurredAt: NOW,
  commandId: requestId,
  causationEventId: null,
  correlationId: requestId,
  metadata: {},
  payload: {
    threadId: ThreadId.make("thread-1"),
    messageId,
    requestId,
    startedAt: NOW,
  },
});

const queryService = (
  readModelRef: Ref.Ref<OrchestrationReadModel>,
): ProjectionSnapshotQueryShape =>
  ({
    getCommandReadModel: () => Ref.get(readModelRef),
  }) as unknown as ProjectionSnapshotQueryShape;

const engineService = (
  events: Queue.Queue<OrchestrationEvent>,
  commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
): OrchestrationEngineShape => ({
  readEvents: () => Stream.empty,
  dispatch: (command) =>
    Ref.update(commands, (current) => [...current, command]).pipe(Effect.as({ sequence: 1 })),
  streamDomainEvents: Stream.fromQueue(events),
  latestSequence: Effect.succeed(0),
});

it.layer(NodeServices.layer)("MessageSpeechReactor", (it) => {
  it.effect("runs different messages concurrently and drains correlated completions", () =>
    Effect.gen(function* () {
      const messageOne = MessageId.make("message-1");
      const messageTwo = MessageId.make("message-2");
      const requestOne = CommandId.make("request-1");
      const requestTwo = CommandId.make("request-2");
      const readModelRef = yield* Ref.make(readModel([]));
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const receipts = yield* Ref.make<ReadonlyArray<OrchestrationRuntimeReceipt>>([]);
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const release = yield* Deferred.make<void>();
      const startedOne = yield* Deferred.make<void>();
      const startedTwo = yield* Deferred.make<void>();
      const active = yield* Ref.make(0);
      const maxActive = yield* Ref.make(0);

      const synthesize = (messageId: MessageId) =>
        Effect.gen(function* () {
          const current = yield* Ref.updateAndGet(active, (count) => count + 1);
          yield* Ref.update(maxActive, (maximum) => Math.max(maximum, current));
          yield* Deferred.succeed(messageId === messageOne ? startedOne : startedTwo, undefined);
          yield* Deferred.await(release);
          yield* Ref.update(active, (count) => count - 1);
          if (messageId === messageTwo) {
            return yield* new MessageSpeechError({ reason: "provider_failed" });
          }
          return speech(messageId);
        });

      const layer = Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, engineService(events, commands)),
        Layer.succeed(ProjectionSnapshotQuery, queryService(readModelRef)),
        Layer.succeed(MessageSpeech, {
          available: true,
          synthesize: ({ messageId }) => synthesize(messageId),
        }),
        Layer.succeed(RuntimeReceiptBus, {
          publish: (receipt) => Ref.update(receipts, (current) => [...current, receipt]),
          streamEventsForTest: Stream.empty,
        }),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* MessageSpeechReactor;
        yield* reactor.start();
        yield* Ref.set(
          readModelRef,
          readModel([
            { messageId: messageOne, requestId: requestOne },
            { messageId: messageTwo, requestId: requestTwo },
          ]),
        );
        yield* Queue.offer(events, requestedEvent(messageOne, requestOne));
        yield* Queue.offer(events, requestedEvent(messageTwo, requestTwo));
        yield* Deferred.await(startedOne);
        yield* Deferred.await(startedTwo);
        assert.equal(yield* Ref.get(maxActive), 2);
        yield* Deferred.succeed(release, undefined);
        yield* reactor.drain;
      }).pipe(Effect.provide(MessageSpeechReactorLive.pipe(Layer.provide(layer))), Effect.scoped);

      const completions = (yield* Ref.get(commands)).filter(
        (command) => command.type === "thread.message.speech.complete",
      );
      assert.equal(completions.length, 2);
      assert.deepEqual(
        completions
          .map((command) => ({
            messageId: command.messageId,
            requestId: command.requestId,
            succeeded: command.speech !== undefined,
          }))
          .sort((left, right) => left.messageId.localeCompare(right.messageId)),
        [
          { messageId: messageOne, requestId: requestOne, succeeded: true },
          { messageId: messageTwo, requestId: requestTwo, succeeded: false },
        ],
      );
      assert.deepEqual(
        (yield* Ref.get(receipts))
          .map((receipt) => ({
            type: receipt.type,
            messageId: "messageId" in receipt ? receipt.messageId : undefined,
            requestId: "requestId" in receipt ? receipt.requestId : undefined,
            succeeded: "succeeded" in receipt ? receipt.succeeded : undefined,
          }))
          .sort((left, right) => (left.messageId ?? "").localeCompare(right.messageId ?? "")),
        [
          {
            type: "message.speech.completed",
            messageId: messageOne,
            requestId: requestOne,
            succeeded: true,
          },
          {
            type: "message.speech.completed",
            messageId: messageTwo,
            requestId: requestTwo,
            succeeded: false,
          },
        ],
      );
    }),
  );

  it.effect("clears requests that were pending before startup", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-stale");
      const requestId = CommandId.make("request-stale");
      const readModelRef = yield* Ref.make(readModel([{ messageId, requestId }]));
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const receipts = yield* Ref.make<ReadonlyArray<OrchestrationRuntimeReceipt>>([]);
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const activation = yield* Deferred.make<void>();
      const layer = Layer.mergeAll(
        Layer.succeed(ServerActivation, Deferred.await(activation)),
        Layer.succeed(OrchestrationEngineService, engineService(events, commands)),
        Layer.succeed(ProjectionSnapshotQuery, queryService(readModelRef)),
        Layer.succeed(MessageSpeech, {
          available: true,
          synthesize: () => Effect.die("stale startup requests must not synthesize"),
        }),
        Layer.succeed(RuntimeReceiptBus, {
          publish: (receipt) => Ref.update(receipts, (current) => [...current, receipt]),
          streamEventsForTest: Stream.empty,
        }),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* MessageSpeechReactor;
        yield* reactor.start();
        yield* Deferred.succeed(activation, undefined);
        yield* reactor.drain;
      }).pipe(Effect.provide(MessageSpeechReactorLive.pipe(Layer.provide(layer))), Effect.scoped);

      const completion = (yield* Ref.get(commands)).find(
        (command) => command.type === "thread.message.speech.complete",
      );
      assert.isTrue(completion !== undefined);
      if (completion?.type === "thread.message.speech.complete") {
        assert.equal(completion.messageId, messageId);
        assert.equal(completion.requestId, requestId);
        assert.equal(completion.speech, undefined);
      }
      const receipt = (yield* Ref.get(receipts)).find(
        (entry) => entry.type === "message.speech.completed",
      );
      assert.isTrue(receipt?.type === "message.speech.completed");
      if (receipt?.type === "message.speech.completed") {
        assert.deepEqual(
          { requestId: receipt.requestId, succeeded: receipt.succeeded },
          { requestId, succeeded: false },
        );
      }
    }),
  );
});
