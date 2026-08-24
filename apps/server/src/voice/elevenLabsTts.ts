import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpBody, type HttpClient, HttpClientResponse } from "effect/unstable/http";

const ELEVENLABS_TEXT_TO_SPEECH_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_TEXT_TO_SPEECH_TIMEOUT = "120 seconds";

export const SPEECH_MIME_TYPE = "audio/mpeg" as const;

export class ElevenLabsTtsError extends Schema.TaggedErrorClass<ElevenLabsTtsError>()(
  "ElevenLabsTtsError",
  {
    reason: Schema.Literals(["request_failed", "empty_audio"]),
  },
) {}

/**
 * One ElevenLabs text-to-speech request, shared by the on-demand listening
 * version and agent voice replies. Fails with `ElevenLabsTtsError` on any
 * transport, status, or empty-body problem so callers can map it onto their
 * own error vocabulary.
 */
export const synthesizeElevenLabsSpeech = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly apiKey: Redacted.Redacted<string>;
  readonly voiceId: string;
  readonly ttsModel: string;
  readonly text: string;
}): Effect.Effect<Uint8Array, ElevenLabsTtsError> =>
  input.httpClient
    .post(
      `${ELEVENLABS_TEXT_TO_SPEECH_URL}/${encodeURIComponent(input.voiceId)}?output_format=mp3_44100_128`,
      {
        headers: { "xi-api-key": Redacted.value(input.apiKey) },
        body: HttpBody.jsonUnsafe({ text: input.text, model_id: input.ttsModel }),
      },
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.timeout(ELEVENLABS_TEXT_TO_SPEECH_TIMEOUT),
      Effect.mapError(() => new ElevenLabsTtsError({ reason: "request_failed" })),
      Effect.flatMap((buffer) => {
        const bytes = new Uint8Array(buffer);
        return bytes.byteLength === 0
          ? Effect.fail(new ElevenLabsTtsError({ reason: "empty_audio" }))
          : Effect.succeed(bytes);
      }),
    );
