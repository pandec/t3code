import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { MessageSpeech, type MessageSpeechError } from "./MessageSpeech.ts";
import { VoiceTranscription } from "./VoiceTranscription.ts";

const failForSpeechError = (error: MessageSpeechError) =>
  Effect.gen(function* () {
    switch (error.reason) {
      case "unavailable":
        return yield* failEnvironmentInternal("speech_unavailable", error);
      case "message_unavailable":
        return yield* failEnvironmentInvalidRequest("speech_message_unavailable");
      case "source_too_long":
        return yield* failEnvironmentInvalidRequest("speech_source_too_long");
      case "script_failed":
        return yield* failEnvironmentInternal("speech_script_failed", error);
      case "provider_failed":
        return yield* failEnvironmentInternal("speech_provider_failed", error);
      case "provider_quota_exceeded":
        return yield* failEnvironmentInternal("speech_provider_quota_exceeded", error);
      case "storage_failed":
        return yield* failEnvironmentInternal("internal_error", error);
    }
  });

export const voiceHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const voiceTranscription = yield* VoiceTranscription;
    const messageSpeech = yield* MessageSpeech;

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
          if (!(yield* messageSpeech.available)) {
            return yield* failEnvironmentInternal(
              "speech_unavailable",
              new Error("Message speech synthesis is unavailable"),
            );
          }
          // Joins the message's server-owned listening job; disconnecting
          // abandons only this wait, never the job.
          return yield* messageSpeech
            .synthesize(args.payload)
            .pipe(Effect.catch(failForSpeechError));
        }),
      );
  }),
);
