import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentHttpApi,
  MESSAGE_SPEECH_MAX_SOURCE_CHARS,
  type MessageSpeechAttachment,
  type MessageSpeechFailureReason,
  type MessageSpeechSynthesisResult,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { messageArtifactTextHash } from "../messageArtifacts/identity.ts";
import { makeMessageArtifactLockCoordinator } from "../messageArtifacts/lock.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { MessageSpeech } from "./MessageSpeech.ts";
import { VoiceTranscription } from "./VoiceTranscription.ts";

type MessageSpeechCompletedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.message-speech-completed" }
>;

const toSynthesisResult = (
  messageId: MessageSpeechSynthesisResult["messageId"],
  speech: MessageSpeechAttachment,
): MessageSpeechSynthesisResult => ({
  messageId,
  speechId: speech.speechId,
  transcript: speech.transcript,
  mimeType: speech.mimeType,
  sizeBytes: speech.sizeBytes,
  origin: speech.origin,
  createdAt: speech.createdAt,
});

export const voiceHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const voiceTranscription = yield* VoiceTranscription;
    const messageSpeech = yield* MessageSpeech;
    const crypto = yield* Crypto.Crypto;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionThreadMessages = yield* ProjectionThreadMessageRepository;
    const requestLocks = yield* makeMessageArtifactLockCoordinator();

    const failForSpeechReason = (reason: MessageSpeechFailureReason, cause: unknown) => {
      switch (reason) {
        case "unavailable":
          return failEnvironmentInternal("speech_unavailable", cause);
        case "message_unavailable":
          return failEnvironmentInvalidRequest("speech_message_unavailable");
        case "source_too_long":
          return failEnvironmentInvalidRequest("speech_source_too_long");
        case "script_failed":
          return failEnvironmentInternal("speech_script_failed", cause);
        case "provider_failed":
          return failEnvironmentInternal("speech_provider_failed", cause);
        case "storage_failed":
          return failEnvironmentInternal("internal_error", cause);
      }
    };

    const readSpeechState = Effect.fn("readMessageSpeechState")(function* (
      messageId: MessageSpeechSynthesisResult["messageId"],
    ) {
      const messageOption = yield* projectionThreadMessages
        .getByMessageId({ messageId })
        .pipe(Effect.catchCause((cause) => failEnvironmentInternal("internal_error", cause)));
      const message = Option.getOrUndefined(messageOption);
      if (
        message === undefined ||
        message.role !== "assistant" ||
        message.isStreaming ||
        message.text.trim().length === 0
      ) {
        return yield* failEnvironmentInvalidRequest("speech_message_unavailable");
      }
      if (message.text.trim().length > MESSAGE_SPEECH_MAX_SOURCE_CHARS) {
        return yield* failEnvironmentInvalidRequest("speech_source_too_long");
      }

      const speechOption = yield* projectionThreadMessages
        .getSpeechByMessageId({ messageId })
        .pipe(Effect.catchCause((cause) => failEnvironmentInternal("internal_error", cause)));
      const projectedSpeech = Option.getOrUndefined(speechOption);
      const speech =
        projectedSpeech !== undefined &&
        (projectedSpeech.origin === "agent" ||
          projectedSpeech.sourceTextHash === messageArtifactTextHash(message.text.trim()))
          ? projectedSpeech
          : undefined;
      return { message, speech };
    });

    const subscribeToCompletion = (
      threadId: MessageSpeechCompletedEvent["payload"]["threadId"],
      messageId: MessageSpeechCompletedEvent["payload"]["messageId"],
    ) =>
      orchestrationEngine.streamDomainEvents.pipe(
        Stream.filter(
          (event): event is MessageSpeechCompletedEvent =>
            event.type === "thread.message-speech-completed" &&
            event.payload.threadId === threadId &&
            event.payload.messageId === messageId,
        ),
        Stream.runHead,
        Effect.forkChild,
      );

    const joinPendingSpeech = Effect.fn("joinPendingMessageSpeech")(function* (
      threadId: MessageSpeechCompletedEvent["payload"]["threadId"],
      messageId: MessageSpeechCompletedEvent["payload"]["messageId"],
    ) {
      while (true) {
        const completionFiber = yield* subscribeToCompletion(threadId, messageId);
        const before = yield* readSpeechState(messageId);
        if (before.speech !== undefined) {
          yield* Fiber.interrupt(completionFiber);
          return toSynthesisResult(messageId, before.speech);
        }
        if (
          before.message.speechRequestId === null ||
          before.message.speechRequestId === undefined
        ) {
          yield* Fiber.interrupt(completionFiber);
          return yield* failEnvironmentInternal(
            "speech_provider_failed",
            new Error("Persistent speech request finished without an attachment"),
          );
        }

        const completion = yield* Fiber.join(completionFiber).pipe(
          Effect.timeout(Duration.minutes(4)),
          Effect.catchCause((cause) => failEnvironmentInternal("speech_provider_failed", cause)),
        );
        const event = Option.getOrUndefined(completion);
        const after = yield* readSpeechState(messageId);
        if (after.speech !== undefined) {
          return toSynthesisResult(messageId, after.speech);
        }
        if (after.message.speechRequestId !== null && after.message.speechRequestId !== undefined) {
          continue;
        }
        if (event?.payload.speech !== undefined) {
          const speech = event.payload.speech;
          if (
            speech.origin === "agent" ||
            speech.sourceTextHash === messageArtifactTextHash(after.message.text.trim())
          ) {
            return toSynthesisResult(messageId, speech);
          }
        }
        const failureReason = event?.payload.failureReason ?? "provider_failed";
        return yield* failForSpeechReason(
          failureReason,
          new Error(`Persistent speech synthesis failed: ${failureReason}`),
        );
      }
    });

    return handlers
      .handle(
        "transcribe",
        Effect.fn("environment.voice.transcribe")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);

          return yield* voiceTranscription.transcribe(args.payload).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                switch (error.reason) {
                  case "unavailable":
                    return yield* failEnvironmentInternal("transcription_unavailable", error);
                  case "invalid_audio":
                    return yield* failEnvironmentInvalidRequest("audio_empty");
                  case "provider_failed":
                    return yield* failEnvironmentInternal("transcription_provider_failed", error);
                }
              }),
            ),
          );
        }),
      )
      .handle(
        "synthesizeMessage",
        Effect.fn("environment.voice.synthesizeMessage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          if (!messageSpeech.available) {
            return yield* failEnvironmentInternal(
              "speech_unavailable",
              new Error("Message speech synthesis is unavailable"),
            );
          }

          return yield* requestLocks.withMessageLock(
            args.payload.messageId,
            Effect.gen(function* () {
              const initial = yield* readSpeechState(args.payload.messageId);
              if (initial.speech !== undefined) {
                return toSynthesisResult(args.payload.messageId, initial.speech);
              }
              if (
                initial.message.speechRequestId !== null &&
                initial.message.speechRequestId !== undefined
              ) {
                return yield* joinPendingSpeech(initial.message.threadId, args.payload.messageId);
              }

              const completionFiber = yield* subscribeToCompletion(
                initial.message.threadId,
                args.payload.messageId,
              );
              const beforeDispatch = yield* readSpeechState(args.payload.messageId);
              if (beforeDispatch.speech !== undefined) {
                yield* Fiber.interrupt(completionFiber);
                return toSynthesisResult(args.payload.messageId, beforeDispatch.speech);
              }
              if (
                beforeDispatch.message.speechRequestId !== null &&
                beforeDispatch.message.speechRequestId !== undefined
              ) {
                yield* Fiber.interrupt(completionFiber);
                return yield* joinPendingSpeech(
                  beforeDispatch.message.threadId,
                  args.payload.messageId,
                );
              }

              const requestId = CommandId.make(
                `server:message-speech-request:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
              );
              const dispatchExit = yield* Effect.exit(
                orchestrationEngine.dispatch({
                  type: "thread.message.speech.request",
                  commandId: requestId,
                  threadId: beforeDispatch.message.threadId,
                  messageId: args.payload.messageId,
                }),
              );
              if (Exit.isFailure(dispatchExit)) {
                yield* Fiber.interrupt(completionFiber);
                const recovered = yield* readSpeechState(args.payload.messageId);
                if (recovered.speech !== undefined) {
                  return toSynthesisResult(args.payload.messageId, recovered.speech);
                }
                if (
                  recovered.message.speechRequestId !== null &&
                  recovered.message.speechRequestId !== undefined
                ) {
                  return yield* joinPendingSpeech(
                    recovered.message.threadId,
                    args.payload.messageId,
                  );
                }
                return yield* failEnvironmentInternal("speech_provider_failed", dispatchExit.cause);
              }

              const completion = yield* Fiber.join(completionFiber).pipe(
                Effect.timeout(Duration.minutes(4)),
                Effect.catchCause((cause) =>
                  failEnvironmentInternal("speech_provider_failed", cause),
                ),
              );
              const event = Option.getOrUndefined(completion);
              const afterDispatch = yield* readSpeechState(args.payload.messageId);
              if (afterDispatch.speech !== undefined) {
                return toSynthesisResult(args.payload.messageId, afterDispatch.speech);
              }
              if (
                afterDispatch.message.speechRequestId !== null &&
                afterDispatch.message.speechRequestId !== undefined
              ) {
                return yield* joinPendingSpeech(
                  afterDispatch.message.threadId,
                  args.payload.messageId,
                );
              }
              const failureReason = event?.payload.failureReason ?? "provider_failed";
              return yield* failForSpeechReason(
                failureReason,
                new Error(`Persistent speech synthesis failed: ${failureReason}`),
              );
            }),
          );
        }),
      );
  }),
);
