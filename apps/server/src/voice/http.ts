import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentHttpApi,
  MESSAGE_SPEECH_MAX_SOURCE_CHARS,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
import { makeMessageArtifactLockCoordinator } from "../messageArtifacts/lock.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { MessageSpeech } from "./MessageSpeech.ts";
import { VoiceTranscription } from "./VoiceTranscription.ts";

type MessageSpeechCompletedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.message-speech-completed" }
>;

export const voiceHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const voiceTranscription = yield* VoiceTranscription;
    const messageSpeech = yield* MessageSpeech;
    const crypto = yield* Crypto.Crypto;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const requestLocks = yield* makeMessageArtifactLockCoordinator();

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
              const readModel = yield* projectionSnapshotQuery
                .getCommandReadModel()
                .pipe(
                  Effect.catchCause((cause) => failEnvironmentInternal("internal_error", cause)),
                );
              const located = readModel.threads
                .flatMap((thread) =>
                  thread.messages.map((message) => ({ threadId: thread.id, message })),
                )
                .find(({ message }) => message.id === args.payload.messageId);
              if (
                located === undefined ||
                located.message.role !== "assistant" ||
                located.message.streaming ||
                located.message.text.trim().length === 0
              ) {
                return yield* failEnvironmentInvalidRequest("speech_message_unavailable");
              }
              if (located.message.text.trim().length > MESSAGE_SPEECH_MAX_SOURCE_CHARS) {
                return yield* failEnvironmentInvalidRequest("speech_source_too_long");
              }
              if (located.message.speech !== undefined) {
                return located.message.speech;
              }

              const requestId =
                located.message.speechRequest?.requestId ??
                CommandId.make(
                  `server:message-speech-request:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
                );
              const completionFiber = yield* orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(
                  (event): event is MessageSpeechCompletedEvent =>
                    event.type === "thread.message-speech-completed" &&
                    event.payload.threadId === located.threadId &&
                    event.payload.messageId === args.payload.messageId &&
                    event.payload.requestId === requestId,
                ),
                Stream.runHead,
                Effect.forkChild,
              );

              if (located.message.speechRequest === undefined) {
                yield* orchestrationEngine
                  .dispatch({
                    type: "thread.message.speech.request",
                    commandId: requestId,
                    threadId: located.threadId,
                    messageId: args.payload.messageId,
                  })
                  .pipe(
                    Effect.catchCause((cause) =>
                      failEnvironmentInternal("speech_provider_failed", cause),
                    ),
                  );
              }

              const completion = yield* Fiber.join(completionFiber).pipe(
                Effect.timeout(Duration.minutes(4)),
                Effect.catchCause((cause) =>
                  failEnvironmentInternal("speech_provider_failed", cause),
                ),
              );
              const speech = Option.getOrUndefined(completion)?.payload.speech;
              if (speech === undefined) {
                return yield* failEnvironmentInternal(
                  "speech_provider_failed",
                  new Error("Persistent speech synthesis completed without an attachment"),
                );
              }
              return {
                messageId: args.payload.messageId,
                speechId: speech.speechId,
                transcript: speech.transcript,
                mimeType: speech.mimeType,
                sizeBytes: speech.sizeBytes,
                origin: speech.origin,
                createdAt: speech.createdAt,
              };
            }),
          );
        }),
      );
  }),
);
