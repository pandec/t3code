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
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import { makeMessageArtifactLockCoordinator } from "../../messageArtifacts/lock.ts";
import { messageArtifactTextHash } from "../../messageArtifacts/identity.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { isMessageSpeechSourceEligible, MessageSpeech } from "../../voice/MessageSpeech.ts";
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
        projected.threadId === input.threadId &&
        projected.speechRequestId === input.requestId &&
        isMessageSpeechSourceEligible({
          role: projected.role,
          isStreaming: projected.isStreaming,
          text: projected.text,
        }),
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

  const processRequest = Effect.fn("processMessageSpeechRequest")(function* (
    event: MessageSpeechRequestedEvent,
  ) {
    const pending = {
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      requestId: event.payload.requestId,
    } satisfies PendingMessageSpeech;
    if (Option.isNone(yield* getCurrentRequestMessage(pending))) return;

    const priorSpeech = yield* projectionThreadMessages.getSpeechByMessageId({
      messageId: pending.messageId,
    });
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

    const currentMessage = Option.getOrUndefined(yield* getCurrentRequestMessage(pending));
    const currentSpeech = currentMessage === undefined ? undefined : outcome.speech;
    const sourceIsCurrent =
      currentMessage !== undefined &&
      currentSpeech?.origin === "user" &&
      currentSpeech.sourceTextHash === messageArtifactTextHash(currentMessage.text.trim());
    const speech = currentSpeech?.origin === "agent" || sourceIsCurrent ? currentSpeech : undefined;
    const failureReason =
      speech === undefined
        ? (outcome.failureReason ?? ("message_unavailable" as const))
        : undefined;
    const prior = Option.getOrUndefined(priorSpeech);

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

    const projectedSpeech = yield* projectionThreadMessages.getSpeechByMessageId({
      messageId: pending.messageId,
    });
    const projected = Option.getOrUndefined(projectedSpeech);
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
    return yield* projectionThreadMessages.listPendingSpeechRequests;
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
