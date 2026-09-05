import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  HttpBody,
  type HttpClient,
  type HttpClientError,
  type HttpClientResponse,
} from "effect/unstable/http";

const ELEVENLABS_TEXT_TO_SPEECH_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_TEXT_TO_SPEECH_TIMEOUT = "120 seconds";

export const SPEECH_MIME_TYPE = "audio/mpeg" as const;

export class ElevenLabsTtsError extends Schema.TaggedErrorClass<ElevenLabsTtsError>()(
  "ElevenLabsTtsError",
  {
    // quota_exceeded: the account has no characters left for this request;
    // retrying cannot help until credits are added or the quota resets.
    reason: Schema.Literals(["request_failed", "quota_exceeded", "empty_audio"]),
  },
) {}

/** The speech failure reason a TTS error maps to, shared by both synthesis paths. */
export const speechFailureReasonFor = (
  error: ElevenLabsTtsError,
): "provider_failed" | "provider_quota_exceeded" =>
  error.reason === "quota_exceeded" ? "provider_quota_exceeded" : "provider_failed";

/**
 * The `detail.status` code of an ElevenLabs error body, or null when the body
 * is not that shape. Quota exhaustion arrives as a 401 with
 * `detail.status: "quota_exceeded"`; by status alone it looks like a bad key.
 */
const errorStatusOf = (body: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("detail" in parsed)) return null;
    const detail = parsed.detail;
    if (typeof detail !== "object" || detail === null || !("status" in detail)) return null;
    return typeof detail.status === "string" ? detail.status : null;
  } catch {
    return null;
  }
};

/**
 * Classifies a non-2xx response and logs why. Only the vendor's status code
 * is logged when the body parses: validation errors can echo the submitted
 * text back, and that is the user's transcript.
 */
const rejectedResponseError = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map(errorStatusOf),
    Effect.tap((errorStatus) =>
      Effect.logWarning("elevenlabs text-to-speech request rejected", {
        status: response.status,
        errorStatus,
      }),
    ),
    Effect.flatMap((errorStatus) =>
      Effect.fail(
        new ElevenLabsTtsError({
          reason: errorStatus === "quota_exceeded" ? "quota_exceeded" : "request_failed",
        }),
      ),
    ),
  );

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
      Effect.flatMap(
        (
          response,
        ): Effect.Effect<ArrayBuffer, HttpClientError.HttpClientError | ElevenLabsTtsError> =>
          response.status >= 200 && response.status < 300
            ? response.arrayBuffer
            : rejectedResponseError(response),
      ),
      Effect.timeout(ELEVENLABS_TEXT_TO_SPEECH_TIMEOUT),
      Effect.mapError((error) =>
        error._tag === "ElevenLabsTtsError"
          ? error
          : new ElevenLabsTtsError({ reason: "request_failed" }),
      ),
      Effect.flatMap((buffer) => {
        const bytes = new Uint8Array(buffer);
        return bytes.byteLength === 0
          ? Effect.fail(new ElevenLabsTtsError({ reason: "empty_audio" }))
          : Effect.succeed(bytes);
      }),
    );
