import {
  VOICE_TRANSCRIPTION_MAX_BYTES,
  type VoiceAudioMimeType,
  type VoiceTranscriptionRequest,
  type VoiceTranscriptionResult,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";

const ELEVENLABS_SPEECH_TO_TEXT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

const ELEVENLABS_TRANSCRIPTION_TIMEOUT = "70 seconds";

export const ElevenLabsTranscriptionResponse = Schema.Struct({
  text: Schema.String,
  language_code: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export class VoiceTranscriptionError extends Schema.TaggedErrorClass<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  {
    reason: Schema.Literals(["unavailable", "invalid_audio", "provider_failed"]),
  },
) {}

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly available: boolean;
    readonly transcribe: (
      request: VoiceTranscriptionRequest,
    ) => Effect.Effect<VoiceTranscriptionResult, VoiceTranscriptionError>;
  }
>()("t3/voice/VoiceTranscription") {}

function fileExtension(mimeType: VoiceAudioMimeType): string {
  switch (mimeType) {
    case "audio/mp4":
      return "m4a";
    case "audio/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
      return "wav";
  }
}

export function decodeVoiceDataUrl(
  request: VoiceTranscriptionRequest,
): Uint8Array | VoiceTranscriptionError {
  const prefix = `data:${request.mimeType};base64,`;
  if (!request.dataUrl.startsWith(prefix)) {
    return new VoiceTranscriptionError({ reason: "invalid_audio" });
  }

  const encoded = request.dataUrl.slice(prefix.length);
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return new VoiceTranscriptionError({ reason: "invalid_audio" });
  }

  const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > VOICE_TRANSCRIPTION_MAX_BYTES ||
    bytes.byteLength !== request.sizeBytes
  ) {
    return new VoiceTranscriptionError({ reason: "invalid_audio" });
  }
  return bytes;
}

export function buildElevenLabsTranscriptionFormData(options: {
  readonly audio: Uint8Array;
  readonly mimeType: VoiceAudioMimeType;
  readonly model: string;
  readonly language?: string;
}): FormData {
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([options.audio], { type: options.mimeType }),
    `recording.${fileExtension(options.mimeType)}`,
  );
  formData.append("model_id", options.model);
  formData.append("tag_audio_events", "false");
  if (options.model === "scribe_v2") {
    formData.append("no_verbatim", "true");
  }
  if (options.language?.trim()) {
    formData.append("language_code", options.language.trim());
  }
  return formData;
}

export const layer = Layer.effect(
  VoiceTranscription,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("ELEVENLABS_API_KEY").pipe(Config.option);
    const model = yield* Config.string("ELEVENLABS_STT_MODEL").pipe(
      Config.withDefault("scribe_v2"),
    );
    const language = yield* Config.string("ELEVENLABS_STT_LANGUAGE").pipe(Config.option);
    const httpClient = yield* HttpClient.HttpClient;
    const available = Option.isSome(apiKey) && Redacted.value(apiKey.value).trim().length > 0;

    const transcribe = Effect.fn("VoiceTranscription.transcribe")(function* (
      request: VoiceTranscriptionRequest,
    ) {
      if (!available || Option.isNone(apiKey)) {
        return yield* new VoiceTranscriptionError({ reason: "unavailable" });
      }

      const decoded = decodeVoiceDataUrl(request);
      if (!(decoded instanceof Uint8Array)) {
        return yield* decoded;
      }

      const formData = buildElevenLabsTranscriptionFormData({
        audio: decoded,
        mimeType: request.mimeType,
        model,
        ...(Option.isSome(language) ? { language: language.value } : {}),
      });

      const response = yield* httpClient
        .post(ELEVENLABS_SPEECH_TO_TEXT_URL, {
          headers: {
            "xi-api-key": Redacted.value(apiKey.value),
          },
          body: HttpBody.formData(formData),
        })
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ElevenLabsTranscriptionResponse)),
          Effect.timeout(ELEVENLABS_TRANSCRIPTION_TIMEOUT),
          Effect.mapError(() => new VoiceTranscriptionError({ reason: "provider_failed" })),
        );

      const text = response.text.trim();
      if (text.length === 0) {
        return yield* new VoiceTranscriptionError({ reason: "invalid_audio" });
      }
      return {
        text,
        ...(response.language_code?.trim() ? { languageCode: response.language_code.trim() } : {}),
      };
    });

    return VoiceTranscription.of({
      available,
      transcribe,
    });
  }),
);
