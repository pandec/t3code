import {
  CommandId,
  type MessageId,
  type MessageSpeechAttachment,
  type OrchestrationEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { MessageSpeech } from "../../voice/MessageSpeech.ts";
import {
  MessageSpeechReactor,
  type MessageSpeechReactorShape,
} from "../Services/MessageSpeechReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";

type MessageSpeechRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.message-speech-requested" }
>;

type PendingMessageSpeech = {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly requestId: CommandId;
};

const MESSAGE_SPEECH_JOB_TIMEOUT = Duration.minutes(3);

export const makeMessageSpeechReactor = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const messageSpeech = yield* MessageSpeech;
  const runtimeReceiptBus = yield* RuntimeReceiptBus;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)),
    );

  const dispatchCompletion = Effect.fn("dispatchMessageSpeechCompletion")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly requestId: CommandId;
    readonly speech?: MessageSpeechAttachment;
  }) {
    const command = {
      type: "thread.message.speech.complete" as const,
      commandId: yield* serverCommandId("message-speech-complete"),
      threadId: input.threadId,
      messageId: input.messageId,
      requestId: input.requestId,
      ...(input.speech !== undefined ? { speech: input.speech } : {}),
    };
    yield* orchestrationEngine.dispatch(command).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.logWarning("message speech reactor retrying completion dispatch", {
          threadId: input.threadId,
          messageId: input.messageId,
          requestId: input.requestId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.andThen(orchestrationEngine.dispatch(command)));
      }),
    );
    yield* runtimeReceiptBus.publish({
      type: "message.speech.completed",
      threadId: input.threadId,
      messageId: input.messageId,
      requestId: input.requestId,
      succeeded: input.speech !== undefined,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  const requestIsCurrent = Effect.fn("messageSpeechRequestIsCurrent")(function* (
    input: PendingMessageSpeech,
  ) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
    const message = thread?.messages.find((entry) => entry.id === input.messageId);
    return message?.speechRequest?.requestId === input.requestId;
  });

  const processRequest = Effect.fn("processMessageSpeechRequest")(function* (
    event: MessageSpeechRequestedEvent,
  ) {
    const pending = {
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      requestId: event.payload.requestId,
    } satisfies PendingMessageSpeech;
    if (!(yield* requestIsCurrent(pending))) return;

    const speech = yield* messageSpeech.synthesize({ messageId: event.payload.messageId }).pipe(
      Effect.timeout(MESSAGE_SPEECH_JOB_TIMEOUT),
      Effect.map(Option.some),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.logWarning("message speech synthesis failed", {
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          requestId: event.payload.requestId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(Option.none<MessageSpeechAttachment>()));
      }),
    );

    yield* dispatchCompletion({
      ...pending,
      ...(Option.isSome(speech) ? { speech: speech.value } : {}),
    });
  });

  const processRequestSafely = (event: MessageSpeechRequestedEvent) =>
    processRequest(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.logWarning("message speech reactor failed to process request", {
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          requestId: event.payload.requestId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  interface MessageLock {
    readonly semaphore: Semaphore.Semaphore;
    readonly users: number;
  }
  const messageLocks = yield* Ref.make<ReadonlyMap<MessageId, MessageLock>>(new Map());
  const messageLocksGuard = yield* Semaphore.make(1);
  const outstanding = yield* TxRef.make(0);

  const withMessageLock = <A, E, R>(
    messageId: MessageId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      messageLocksGuard.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(messageLocks);
          const existing = current.get(messageId);
          if (existing !== undefined) {
            yield* Ref.set(
              messageLocks,
              new Map(current).set(messageId, {
                semaphore: existing.semaphore,
                users: existing.users + 1,
              }),
            );
            return existing.semaphore;
          }
          const semaphore = yield* Semaphore.make(1);
          yield* Ref.set(messageLocks, new Map(current).set(messageId, { semaphore, users: 1 }));
          return semaphore;
        }),
      ),
      (semaphore) => semaphore.withPermits(1)(effect),
      (semaphore) =>
        messageLocksGuard.withPermits(1)(
          Ref.update(messageLocks, (current) => {
            const existing = current.get(messageId);
            if (existing === undefined || existing.semaphore !== semaphore) return current;
            const next = new Map(current);
            if (existing.users === 1) {
              next.delete(messageId);
            } else {
              next.set(messageId, { semaphore, users: existing.users - 1 });
            }
            return next;
          }),
        ),
    );

  const trackOutstanding = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.ensuring(TxRef.update(outstanding, (count) => count - 1).pipe(Effect.tx)),
      Effect.interruptible,
    );

  const enqueueRequest = (event: MessageSpeechRequestedEvent) =>
    TxRef.update(outstanding, (count) => count + 1).pipe(
      Effect.tx,
      Effect.andThen(
        Effect.forkScoped(
          trackOutstanding(withMessageLock(event.payload.messageId, processRequestSafely(event))),
        ),
      ),
      Effect.asVoid,
      Effect.uninterruptible,
    );

  const forkTrackedParked = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    activation: Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const parked = yield* Deferred.make<void>();
      yield* TxRef.update(outstanding, (count) => count + 1).pipe(Effect.tx);
      yield* Effect.forkScoped(
        Deferred.succeed(parked, undefined).pipe(
          Effect.andThen(activation),
          Effect.andThen(effect),
          Effect.ensuring(TxRef.update(outstanding, (count) => count - 1).pipe(Effect.tx)),
          Effect.interruptible,
        ),
      );
      yield* Deferred.await(parked);
    }).pipe(Effect.uninterruptible);

  const findInterruptedRequests = Effect.fn("findInterruptedMessageSpeechRequests")(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) =>
      thread.messages.flatMap((message) =>
        message.speechRequest === undefined
          ? []
          : [
              {
                threadId: thread.id,
                messageId: message.id,
                requestId: message.speechRequest.requestId,
              } satisfies PendingMessageSpeech,
            ],
      ),
    );
  });

  const clearInterruptedRequests = Effect.fn("clearInterruptedMessageSpeechRequests")(function* (
    requests: ReadonlyArray<PendingMessageSpeech>,
  ) {
    yield* Effect.forEach(
      requests,
      (request) =>
        dispatchCompletion(request).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
            return Effect.logWarning("message speech reactor failed to clear interrupted request", {
              ...request,
              cause: Cause.pretty(cause),
            });
          }),
        ),
      { discard: true },
    );
  });

  const start: MessageSpeechReactorShape["start"] = Effect.fn("start")(function* () {
    const interruptedRequests = yield* findInterruptedRequests().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.logWarning("message speech reactor failed to find interrupted requests", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([] as ReadonlyArray<PendingMessageSpeech>));
      }),
    );

    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.message-speech-requested") return Effect.void;
        return enqueueRequest(event);
      }),
    );

    const clearInterrupted = clearInterruptedRequests(interruptedRequests);
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* clearInterrupted;
    } else {
      yield* forkTrackedParked(clearInterrupted, activation);
    }
  });

  return {
    start,
    drain: TxRef.get(outstanding).pipe(
      Effect.tap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    ),
  } satisfies MessageSpeechReactorShape;
});

export const MessageSpeechReactorLive = Layer.effect(
  MessageSpeechReactor,
  makeMessageSpeechReactor,
);
