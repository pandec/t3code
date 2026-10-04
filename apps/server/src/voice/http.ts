import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { VoiceTranscription } from "./VoiceTranscription.ts";

export const voiceHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const voiceTranscription = yield* VoiceTranscription;

    return handlers.handle(
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
    );
  }),
);
