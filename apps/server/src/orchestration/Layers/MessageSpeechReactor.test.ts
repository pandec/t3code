import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type MessageSpeechAttachment,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { messageArtifactTextHash } from "../../messageArtifacts/identity.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionMessageSpeech,
  type ProjectionThreadMessage,
  type ProjectionThreadMessageRepositoryShape,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { MessageSpeech, MessageSpeechError } from "../../voice/MessageSpeech.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { MessageSpeechReactor } from "../Services/MessageSpeechReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../Services/RuntimeReceiptBus.ts";
import { MessageSpeechReactorLive } from "./MessageSpeechReactor.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const speech = (
  messageId: MessageId,
): Extract<MessageSpeechAttachment, { readonly origin: "user" }> => ({
  speechId: `speech:${messageId}`,
  transcript: `Speech for ${messageId}`,
  mimeType: "audio/mpeg",
  sizeBytes: 123,
  sourceTextHash: messageArtifactTextHash(`Message ${messageId}`),
  scriptRecipeHash: "recipe-hash",
  voiceId: "voice-1",
  ttsModel: "model-1",
  origin: "user",
  createdAt: NOW,
});

const projectionSpeech = (
  messageId: MessageId,
  attachment: Extract<MessageSpeechAttachment, { readonly origin: "user" }>,
): ProjectionMessageSpeech => ({
  messageId,
  threadId: ThreadId.make("thread-1"),
  ...attachment,
});

const projectionMessage = (
  messageId: MessageId,
  requestId: CommandId,
): ProjectionThreadMessage => ({
  messageId,
  threadId: ThreadId.make("thread-1"),
  turnId: null,
  role: "assistant",
  text: `Message ${messageId}`,
  speechRequestId: requestId,
  speechRequestStartedAt: NOW,
  isStreaming: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const repositoryService = (
  messages: Ref.Ref<ReadonlyMap<MessageId, ProjectionThreadMessage>>,
): ProjectionThreadMessageRepositoryShape => ({
  upsert: (message) =>
    Ref.update(messages, (current) => new Map(current).set(message.messageId, message)),
  appendStreaming: () => Effect.void,
  getByMessageId: ({ messageId }) =>
    Ref.get(messages).pipe(
      Effect.map((current) => {
        const message = current.get(messageId);
        return message === undefined ? Option.none() : Option.some(message);
      }),
    ),
  getSpeechByMessageId: () => Effect.succeed(Option.none()),
  listPendingSpeechRequests: Ref.get(messages).pipe(
    Effect.map((current) =>
      [...current.values()].flatMap((message) =>
        message.speechRequestId === null || message.speechRequestId === undefined
          ? []
          : [
              {
                threadId: message.threadId,
                messageId: message.messageId,
                requestId: message.speechRequestId,
              },
            ],
      ),
    ),
  ),
  listByThreadId: ({ threadId }) =>
    Ref.get(messages).pipe(
      Effect.map((current) =>
        [...current.values()].filter((message) => message.threadId === threadId),
      ),
    ),
  getLatestUserMessageAt: () => Effect.succeed(null),
  deleteByThreadId: ({ threadId }) =>
    Ref.update(
      messages,
      (current) => new Map([...current].filter(([, message]) => message.threadId !== threadId)),
    ),
  copyTextMessagesForFork: () => Effect.void,
});

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

const engineService = (
  events: Queue.Queue<OrchestrationEvent>,
  commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
): OrchestrationEngineShape => ({
  readEvents: () => Stream.empty,
  dispatch: (command) =>
    Ref.update(commands, (current) => [...current, command]).pipe(Effect.as({ sequence: 1 })),
  streamDomainEvents: Stream.fromQueue(events),
  subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
  getEventReplayStats: () => Effect.succeed({ eventCount: 0, payloadBytes: 0 }),
  latestSequence: Effect.succeed(0),
});

it.layer(NodeServices.layer)("MessageSpeechReactor", (it) => {
  it.effect("runs different messages concurrently and drains correlated completions", () =>
    Effect.gen(function* () {
      const messageOne = MessageId.make("message-1");
      const messageTwo = MessageId.make("message-2");
      const requestOne = CommandId.make("request-1");
      const requestTwo = CommandId.make("request-2");
      const messages = yield* Ref.make<ReadonlyMap<MessageId, ProjectionThreadMessage>>(new Map());
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
        Layer.succeed(ProjectionThreadMessageRepository, repositoryService(messages)),
        Layer.succeed(MessageSpeech, {
          available: true,
          synthesize: ({ messageId }) => synthesize(messageId),
          deleteAttachment: () => Effect.void,
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
          messages,
          new Map([
            [messageOne, projectionMessage(messageOne, requestOne)],
            [messageTwo, projectionMessage(messageTwo, requestTwo)],
          ]),
        );
        yield* Queue.offer(events, requestedEvent(messageOne, requestOne));
        yield* Queue.offer(events, requestedEvent(messageTwo, requestTwo));
        yield* Deferred.await(startedOne);
        yield* Deferred.await(startedTwo);
        assert.equal(yield* Ref.get(maxActive), 2);
        yield* Deferred.succeed(release, undefined);
        yield* reactor.drain;
      }).pipe(
        Effect.provide(MessageSpeechReactorLive.pipe(Layer.provideMerge(layer))),
        Effect.scoped,
      );

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
            failureReason: command.failureReason,
          }))
          .sort((left, right) => left.messageId.localeCompare(right.messageId)),
        [
          {
            messageId: messageOne,
            requestId: requestOne,
            succeeded: true,
            failureReason: undefined,
          },
          {
            messageId: messageTwo,
            requestId: requestTwo,
            succeeded: false,
            failureReason: "provider_failed",
          },
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

  it.effect("retries completion dispatch with one command id", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-retry");
      const requestId = CommandId.make("request-retry");
      const messages = yield* Ref.make<ReadonlyMap<MessageId, ProjectionThreadMessage>>(new Map());
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const dispatchAttempts = yield* Ref.make(0);
      const attemptedCommandIds = yield* Queue.unbounded<CommandId>();
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const layer = Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, {
          ...engineService(events, commands),
          dispatch: (command) =>
            Ref.update(commands, (current) => [...current, command]).pipe(
              Effect.andThen(Queue.offer(attemptedCommandIds, command.commandId)),
              Effect.andThen(Ref.updateAndGet(dispatchAttempts, (attempt) => attempt + 1)),
              Effect.flatMap((attempt) =>
                attempt < 3
                  ? Effect.fail(
                      new OrchestrationCommandInvariantError({
                        commandType: command.type,
                        detail: "retry completion",
                      }),
                    )
                  : Effect.succeed({ sequence: 1 }),
              ),
            ),
        }),
        Layer.succeed(ProjectionThreadMessageRepository, repositoryService(messages)),
        Layer.succeed(MessageSpeech, {
          available: true,
          synthesize: () => Effect.succeed(speech(messageId)),
          deleteAttachment: () => Effect.void,
        }),
        Layer.succeed(RuntimeReceiptBus, {
          publish: () => Effect.void,
          streamEventsForTest: Stream.empty,
        }),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* MessageSpeechReactor;
        yield* reactor.start();
        yield* Ref.set(messages, new Map([[messageId, projectionMessage(messageId, requestId)]]));
        yield* Queue.offer(events, requestedEvent(messageId, requestId));
        const firstCommandId = yield* Queue.take(attemptedCommandIds);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("100 millis");
        const secondCommandId = yield* Queue.take(attemptedCommandIds);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("200 millis");
        const thirdCommandId = yield* Queue.take(attemptedCommandIds);
        assert.equal(new Set([firstCommandId, secondCommandId, thirdCommandId]).size, 1);
        yield* reactor.drain;
      }).pipe(
        Effect.provide(MessageSpeechReactorLive.pipe(Layer.provideMerge(layer))),
        Effect.scoped,
      );

      const completions = (yield* Ref.get(commands)).filter(
        (command) => command.type === "thread.message.speech.complete",
      );
      assert.equal(completions.length, 3);
      assert.equal(new Set(completions.map((command) => command.commandId)).size, 1);
    }),
  );

  it.effect("removes a superseded user attachment after projection commits", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-replaced");
      const requestId = CommandId.make("request-replaced");
      const previous = {
        ...speech(messageId),
        speechId: "speech-previous",
      } satisfies Extract<MessageSpeechAttachment, { readonly origin: "user" }>;
      const replacement = speech(messageId);
      const messages = yield* Ref.make<ReadonlyMap<MessageId, ProjectionThreadMessage>>(new Map());
      const projectedSpeech = yield* Ref.make<Option.Option<ProjectionMessageSpeech>>(
        Option.some(projectionSpeech(messageId, previous)),
      );
      const deletedSpeechIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const completionDispatched = yield* Deferred.make<void>();
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const repository = {
        ...repositoryService(messages),
        getSpeechByMessageId: () => Ref.get(projectedSpeech),
      } satisfies ProjectionThreadMessageRepositoryShape;
      const layer = Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, {
          ...engineService(events, commands),
          dispatch: (command) =>
            Ref.update(commands, (current) => [...current, command]).pipe(
              Effect.tap(() =>
                command.type === "thread.message.speech.complete"
                  ? Ref.set(
                      projectedSpeech,
                      Option.some(projectionSpeech(messageId, replacement)),
                    ).pipe(Effect.andThen(Deferred.succeed(completionDispatched, undefined)))
                  : Effect.void,
              ),
              Effect.as({ sequence: 1 }),
            ),
        }),
        Layer.succeed(ProjectionThreadMessageRepository, repository),
        Layer.succeed(MessageSpeech, {
          available: true,
          synthesize: () => Effect.succeed(replacement),
          deleteAttachment: (speechId) =>
            Ref.update(deletedSpeechIds, (current) => [...current, speechId]),
        }),
        Layer.succeed(RuntimeReceiptBus, {
          publish: () => Effect.void,
          streamEventsForTest: Stream.empty,
        }),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* MessageSpeechReactor;
        yield* reactor.start();
        yield* Ref.set(messages, new Map([[messageId, projectionMessage(messageId, requestId)]]));
        yield* Queue.offer(events, requestedEvent(messageId, requestId));
        yield* Deferred.await(completionDispatched);
        yield* reactor.drain;
      }).pipe(
        Effect.provide(MessageSpeechReactorLive.pipe(Layer.provideMerge(layer))),
        Effect.scoped,
      );

      assert.deepEqual(yield* Ref.get(deletedSpeechIds), [previous.speechId]);
    }),
  );

  it.effect("completes a current request that becomes ineligible", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-streaming");
      const requestId = CommandId.make("request-streaming");
      const messages = yield* Ref.make<ReadonlyMap<MessageId, ProjectionThreadMessage>>(new Map());
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const completionDispatched = yield* Deferred.make<void>();
      const layer = Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, {
          ...engineService(events, commands),
          dispatch: (command) =>
            Ref.update(commands, (current) => [...current, command]).pipe(
              Effect.tap(() =>
                command.type === "thread.message.speech.complete"
                  ? Deferred.succeed(completionDispatched, undefined)
                  : Effect.void,
              ),
              Effect.as({ sequence: 1 }),
            ),
        }),
        Layer.succeed(ProjectionThreadMessageRepository, repositoryService(messages)),
        Layer.succeed(MessageSpeech, {
          available: true,
          synthesize: () =>
            Effect.gen(function* () {
              yield* Ref.set(
                messages,
                new Map([
                  [messageId, { ...projectionMessage(messageId, requestId), isStreaming: true }],
                ]),
              );
              return yield* new MessageSpeechError({ reason: "provider_failed" });
            }),
          deleteAttachment: () => Effect.void,
        }),
        Layer.succeed(RuntimeReceiptBus, {
          publish: () => Effect.void,
          streamEventsForTest: Stream.empty,
        }),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* MessageSpeechReactor;
        yield* reactor.start();
        yield* Ref.set(messages, new Map([[messageId, projectionMessage(messageId, requestId)]]));
        yield* Queue.offer(events, requestedEvent(messageId, requestId));
        yield* Deferred.await(completionDispatched);
        yield* reactor.drain;
      }).pipe(
        Effect.provide(MessageSpeechReactorLive.pipe(Layer.provideMerge(layer))),
        Effect.scoped,
      );

      const completion = (yield* Ref.get(commands)).find(
        (candidate) => candidate.type === "thread.message.speech.complete",
      );
      assert.isTrue(completion?.type === "thread.message.speech.complete");
      if (completion?.type === "thread.message.speech.complete") {
        assert.equal(completion.requestId, requestId);
        assert.equal(completion.speech, undefined);
        assert.equal(completion.failureReason, "message_unavailable");
      }
    }),
  );

  it.effect("cleans generated audio when the post-synthesis projection read fails", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-read-failure");
      const requestId = CommandId.make("request-read-failure");
      const generated = speech(messageId);
      const messages = yield* Ref.make<ReadonlyMap<MessageId, ProjectionThreadMessage>>(new Map());
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const currentMessageReads = yield* Ref.make(0);
      const failedReadAttempts = yield* Queue.unbounded<number>();
      const deletedSpeechIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const completionDispatched = yield* Deferred.make<void>();
      const baseRepository = repositoryService(messages);
      const repository: ProjectionThreadMessageRepositoryShape = {
        ...baseRepository,
        getByMessageId: ({ messageId: requestedMessageId }) =>
          Ref.updateAndGet(currentMessageReads, (count) => count + 1).pipe(
            Effect.flatMap((attempt) => {
              if (attempt === 1)
                return baseRepository.getByMessageId({ messageId: requestedMessageId });
              return Queue.offer(failedReadAttempts, attempt).pipe(
                Effect.andThen(
                  Effect.fail(
                    new PersistenceSqlError({
                      operation: "get message after speech synthesis",
                    }),
                  ),
                ),
              );
            }),
          ),
      };
      const layer = Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, {
          ...engineService(events, commands),
          dispatch: (command) =>
            Ref.update(commands, (current) => [...current, command]).pipe(
              Effect.tap(() =>
                command.type === "thread.message.speech.complete"
                  ? Deferred.succeed(completionDispatched, undefined)
                  : Effect.void,
              ),
              Effect.as({ sequence: 1 }),
            ),
        }),
        Layer.succeed(ProjectionThreadMessageRepository, repository),
        Layer.succeed(MessageSpeech, {
          available: true,
          synthesize: () => Effect.succeed(generated),
          deleteAttachment: (speechId) =>
            Ref.update(deletedSpeechIds, (current) => [...current, speechId]),
        }),
        Layer.succeed(RuntimeReceiptBus, {
          publish: () => Effect.void,
          streamEventsForTest: Stream.empty,
        }),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* MessageSpeechReactor;
        yield* reactor.start();
        yield* Ref.set(messages, new Map([[messageId, projectionMessage(messageId, requestId)]]));
        yield* Queue.offer(events, requestedEvent(messageId, requestId));
        assert.equal(yield* Queue.take(failedReadAttempts), 2);
        yield* TestClock.adjust("50 millis");
        assert.equal(yield* Queue.take(failedReadAttempts), 3);
        yield* TestClock.adjust("100 millis");
        assert.equal(yield* Queue.take(failedReadAttempts), 4);
        yield* Deferred.await(completionDispatched);
        yield* reactor.drain;
      }).pipe(
        Effect.provide(MessageSpeechReactorLive.pipe(Layer.provideMerge(layer))),
        Effect.scoped,
      );

      const completion = (yield* Ref.get(commands)).find(
        (candidate) => candidate.type === "thread.message.speech.complete",
      );
      assert.isTrue(completion?.type === "thread.message.speech.complete");
      if (completion?.type === "thread.message.speech.complete") {
        assert.equal(completion.requestId, requestId);
        assert.equal(completion.speech, undefined);
        assert.equal(completion.failureReason, "storage_failed");
      }
      assert.deepEqual(yield* Ref.get(deletedSpeechIds), [generated.speechId]);
    }),
  );

  it.effect("fails startup when pending-request reconciliation reads keep failing", () =>
    Effect.gen(function* () {
      const messages = yield* Ref.make<ReadonlyMap<MessageId, ProjectionThreadMessage>>(new Map());
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const attempts = yield* Ref.make(0);
      const attemptedReads = yield* Queue.unbounded<number>();
      const baseRepository = repositoryService(messages);
      const listPendingSpeechRequests: ProjectionThreadMessageRepositoryShape["listPendingSpeechRequests"] =
        Effect.gen(function* () {
          const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
          yield* Queue.offer(attemptedReads, attempt);
          return yield* new PersistenceSqlError({
            operation: "list pending speech requests",
          });
        });
      const repository: ProjectionThreadMessageRepositoryShape = {
        ...baseRepository,
        listPendingSpeechRequests,
      };
      const layer = Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, engineService(events, commands)),
        Layer.succeed(ProjectionThreadMessageRepository, repository),
        Layer.succeed(MessageSpeech, {
          available: true,
          synthesize: () => Effect.die("startup must fail before synthesis"),
          deleteAttachment: () => Effect.void,
        }),
        Layer.succeed(RuntimeReceiptBus, {
          publish: () => Effect.void,
          streamEventsForTest: Stream.empty,
        }),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* MessageSpeechReactor;
        const startFiber = yield* reactor.start().pipe(Effect.exit, Effect.forkChild);
        assert.equal(yield* Queue.take(attemptedReads), 1);
        yield* TestClock.adjust("50 millis");
        assert.equal(yield* Queue.take(attemptedReads), 2);
        yield* TestClock.adjust("100 millis");
        assert.equal(yield* Queue.take(attemptedReads), 3);
        const startExit = yield* Fiber.join(startFiber);
        assert.isTrue(Exit.isFailure(startExit));
        if (Exit.isFailure(startExit)) {
          assert.instanceOf(Cause.squash(startExit.cause), PersistenceSqlError);
        }
      }).pipe(
        Effect.provide(MessageSpeechReactorLive.pipe(Layer.provideMerge(layer))),
        Effect.scoped,
      );
    }),
  );

  it.effect("clears requests that were pending before startup", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-stale");
      const requestId = CommandId.make("request-stale");
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const receipts = yield* Ref.make<ReadonlyArray<OrchestrationRuntimeReceipt>>([]);
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const activation = yield* Deferred.make<void>();
      const persistenceLayer = ProjectionThreadMessageRepositoryLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
      );
      const layer = Layer.mergeAll(
        Layer.succeed(ServerActivation, Deferred.await(activation)),
        Layer.succeed(OrchestrationEngineService, engineService(events, commands)),
        Layer.succeed(MessageSpeech, {
          available: true,
          synthesize: () => Effect.die("stale startup requests must not synthesize"),
          deleteAttachment: () => Effect.void,
        }),
        Layer.succeed(RuntimeReceiptBus, {
          publish: (receipt) => Ref.update(receipts, (current) => [...current, receipt]),
          streamEventsForTest: Stream.empty,
        }),
        persistenceLayer,
      );

      yield* Effect.gen(function* () {
        const repository = yield* ProjectionThreadMessageRepository;
        yield* repository.upsert(projectionMessage(messageId, requestId));
        const reactor = yield* MessageSpeechReactor;
        yield* reactor.start();
        yield* Deferred.succeed(activation, undefined);
        yield* reactor.drain;
      }).pipe(
        Effect.provide(MessageSpeechReactorLive.pipe(Layer.provideMerge(layer))),
        Effect.scoped,
      );

      const completion = (yield* Ref.get(commands)).find(
        (command) => command.type === "thread.message.speech.complete",
      );
      assert.isTrue(completion !== undefined);
      if (completion?.type === "thread.message.speech.complete") {
        assert.equal(completion.messageId, messageId);
        assert.equal(completion.requestId, requestId);
        assert.equal(completion.speech, undefined);
        assert.equal(completion.failureReason, "provider_failed");
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
