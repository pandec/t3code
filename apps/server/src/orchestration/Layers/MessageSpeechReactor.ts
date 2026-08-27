import {
  CommandId,
  type MessageId,
  type MessageSpeechAttachment,
  type MessageSpeechFailureReason,
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
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import { makeMessageArtifactLockCoordinator } from "../../messageArtifacts/lock.ts";
import { messageArtifactTextHash } from "../../messageArtifacts/identity.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { getMessageSpeechSourceFailureReason, MessageSpeech } from "../../voice/MessageSpeech.ts";
import {
  MessageSpeechReactor,
  type MessageSpeechReactorShape,
} from "../Services/MessageSpeechReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
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

type MessageSpeechSynthesisOutcome =
  | { readonly speech: MessageSpeechAttachment; readonly failureReason?: never }
  | { readonly speech?: never; readonly failureReason: MessageSpeechFailureReason };

const MESSAGE_SPEECH_JOB_TIMEOUT = Duration.minutes(3);
const MESSAGE_SPEECH_PROJECTION_READ_RETRIES = 2;
const MESSAGE_SPEECH_PROJECTION_READ_RETRY_SCHEDULE = Schedule.exponential(Duration.millis(50));
const MESSAGE_SPEECH_COMPLETION_RETRIES = 5;
const MESSAGE_SPEECH_COMPLETION_RETRY_SCHEDULE = Schedule.exponential(Duration.millis(100)).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(2))),
  ),
);

export const makeMessageSpeechReactor = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionThreadMessages = yield* ProjectionThreadMessageRepository;
  const messageSpeech = yield* MessageSpeech;
  const runtimeReceiptBus = yield* RuntimeReceiptBus;
  const requestLocks = yield* makeMessageArtifactLockCoordinator();

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
    readonly failureReason?: MessageSpeechFailureReason;
  }) {
    const command = {
      type: "thread.message.speech.complete" as const,
      commandId: yield* serverCommandId("message-speech-complete"),
      threadId: input.threadId,
      messageId: input.messageId,
      requestId: input.requestId,
      ...(input.speech !== undefined ? { speech: input.speech } : {}),
      ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
    };
    yield* orchestrationEngine.dispatch(command).pipe(
      Effect.retry({
        times: MESSAGE_SPEECH_COMPLETION_RETRIES,
        schedule: MESSAGE_SPEECH_COMPLETION_RETRY_SCHEDULE,
      }),
      Effect.tapError((error) =>
        Effect.logError("message speech reactor exhausted completion dispatch retries", {
          threadId: input.threadId,
          messageId: input.messageId,
          requestId: input.requestId,
          error,
        }),
      ),
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

  const getCurrentRequestMessage = Effect.fn("getCurrentMessageSpeechRequest")(function* (
    input: PendingMessageSpeech,
  ) {
    const message = yield* projectionThreadMessages.getByMessageId({ messageId: input.messageId });
    return Option.filter(
      message,
      (projected) =>
        projected.threadId === input.threadId && projected.speechRequestId === input.requestId,
    );
  });

  const deleteSpeechAttachment = (speechId: string, messageId: MessageId) =>
    messageSpeech.deleteAttachment(speechId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("message speech reactor failed to remove superseded attachment", {
          messageId,
          speechId,
          reason: error.reason,
        }),
      ),
    );

  const retryProjectionRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.retry({
        times: MESSAGE_SPEECH_PROJECTION_READ_RETRIES,
        schedule: MESSAGE_SPEECH_PROJECTION_READ_RETRY_SCHEDULE,
      }),
    );

  const readProjection = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    retryProjectionRead(effect).pipe(Effect.result);

  const completeAfterProjectionFailure = Effect.fn("completeMessageSpeechAfterProjectionFailure")(
    function* (input: {
      readonly pending: PendingMessageSpeech;
      readonly operation: string;
      readonly cause: unknown;
      readonly generatedSpeech?: MessageSpeechAttachment;
      readonly priorSpeechId?: string;
    }) {
      yield* Effect.logWarning("message speech reactor projection read failed", {
        ...input.pending,
        operation: input.operation,
        cause: input.cause,
      });
      yield* dispatchCompletion({ ...input.pending, failureReason: "storage_failed" }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "message speech reactor failed to clear request after projection error",
            {
              ...input.pending,
              operation: input.operation,
              cause: Cause.pretty(cause),
            },
          ),
        ),
      );
      if (
        input.generatedSpeech?.origin === "user" &&
        input.generatedSpeech.speechId !== input.priorSpeechId
      ) {
        yield* deleteSpeechAttachment(input.generatedSpeech.speechId, input.pending.messageId);
      }
    },
  );

  const processRequest = Effect.fn("processMessageSpeechRequest")(function* (
    event: MessageSpeechRequestedEvent,
  ) {
    const pending = {
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      requestId: event.payload.requestId,
    } satisfies PendingMessageSpeech;
    const initialMessageResult = yield* readProjection(getCurrentRequestMessage(pending));
    if (Result.isFailure(initialMessageResult)) {
      yield* completeAfterProjectionFailure({
        pending,
        operation: "read current request before synthesis",
        cause: initialMessageResult.failure,
      });
      return;
    }
    const initialMessage = Option.getOrUndefined(initialMessageResult.success);
    if (initialMessage === undefined) return;

    const initialFailureReason = getMessageSpeechSourceFailureReason(initialMessage);
    if (initialFailureReason !== null) {
      yield* dispatchCompletion({ ...pending, failureReason: initialFailureReason });
      return;
    }

    const priorSpeechResult = yield* readProjection(
      projectionThreadMessages.getSpeechByMessageId({ messageId: pending.messageId }),
    );
    if (Result.isFailure(priorSpeechResult)) {
      yield* completeAfterProjectionFailure({
        pending,
        operation: "read prior speech before synthesis",
        cause: priorSpeechResult.failure,
      });
      return;
    }
    const prior = Option.getOrUndefined(priorSpeechResult.success);

    const outcome: MessageSpeechSynthesisOutcome = yield* messageSpeech
      .synthesize({ messageId: event.payload.messageId })
      .pipe(
        Effect.map((speech): MessageSpeechSynthesisOutcome => ({ speech })),
        Effect.catchTag("MessageSpeechError", (error) =>
          Effect.logWarning("message speech synthesis failed", {
            threadId: pending.threadId,
            messageId: pending.messageId,
            requestId: pending.requestId,
            reason: error.reason,
          }).pipe(Effect.as<MessageSpeechSynthesisOutcome>({ failureReason: error.reason })),
        ),
        Effect.timeout(MESSAGE_SPEECH_JOB_TIMEOUT),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          return Effect.logWarning("message speech synthesis timed out or died", {
            threadId: pending.threadId,
            messageId: pending.messageId,
            requestId: pending.requestId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as<MessageSpeechSynthesisOutcome>({ failureReason: "provider_failed" }));
        }),
      );

    const currentMessageResult = yield* readProjection(getCurrentRequestMessage(pending));
    if (Result.isFailure(currentMessageResult)) {
      yield* completeAfterProjectionFailure({
        pending,
        operation: "read current request after synthesis",
        cause: currentMessageResult.failure,
        ...(outcome.speech !== undefined ? { generatedSpeech: outcome.speech } : {}),
        ...(prior?.speechId !== undefined ? { priorSpeechId: prior.speechId } : {}),
      });
      return;
    }
    const currentMessage = Option.getOrUndefined(currentMessageResult.success);
    const currentFailureReason =
      currentMessage === undefined
        ? "message_unavailable"
        : getMessageSpeechSourceFailureReason(currentMessage);
    const currentSpeech = currentFailureReason === null ? outcome.speech : undefined;
    const sourceIsCurrent =
      currentMessage !== undefined &&
      currentSpeech?.origin === "user" &&
      currentSpeech.sourceTextHash === messageArtifactTextHash(currentMessage.text.trim());
    const speech = currentSpeech?.origin === "agent" || sourceIsCurrent ? currentSpeech : undefined;
    const failureReason =
      speech === undefined
        ? (currentFailureReason ?? outcome.failureReason ?? ("message_unavailable" as const))
        : undefined;

    yield* dispatchCompletion({
      ...pending,
      ...(speech !== undefined ? { speech } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
    }).pipe(
      Effect.tapError(() =>
        outcome.speech?.origin === "user" && prior?.speechId !== outcome.speech.speechId
          ? deleteSpeechAttachment(outcome.speech.speechId, pending.messageId)
          : Effect.void,
      ),
    );

    const projectedSpeechResult = yield* readProjection(
      projectionThreadMessages.getSpeechByMessageId({ messageId: pending.messageId }),
    );
    if (Result.isFailure(projectedSpeechResult)) {
      yield* Effect.logWarning("message speech reactor could not confirm projected speech", {
        ...pending,
        cause: projectedSpeechResult.failure,
      });
      return;
    }
    const projected = Option.getOrUndefined(projectedSpeechResult.success);
    if (
      speech?.origin === "user" &&
      projected?.speechId === speech.speechId &&
      prior?.origin === "user" &&
      prior.speechId !== speech.speechId
    ) {
      yield* deleteSpeechAttachment(prior.speechId, pending.messageId);
    } else if (
      outcome.speech?.origin === "user" &&
      projected?.speechId !== outcome.speech.speechId &&
      prior?.speechId !== outcome.speech.speechId
    ) {
      yield* deleteSpeechAttachment(outcome.speech.speechId, pending.messageId);
    }
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

  const outstanding = yield* TxRef.make(0);

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
          trackOutstanding(
            requestLocks.withMessageLock(event.payload.messageId, processRequestSafely(event)),
          ),
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
    return yield* retryProjectionRead(projectionThreadMessages.listPendingSpeechRequests);
  });

  const clearInterruptedRequests = Effect.fn("clearInterruptedMessageSpeechRequests")(function* (
    requests: ReadonlyArray<PendingMessageSpeech>,
  ) {
    yield* Effect.forEach(
      requests,
      (request) =>
        dispatchCompletion({ ...request, failureReason: "provider_failed" }).pipe(
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
    const interruptedRequests = yield* findInterruptedRequests();

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
