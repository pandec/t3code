import type { TtsCatalogModel, TtsCatalogVoice } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  HttpBody,
  HttpClientRequest,
  HttpClientResponse,
  type HttpClient,
  type HttpClientError,
} from "effect/unstable/http";

import { MP3_MIME_TYPE, TtsError, type SynthesizedSpeech } from "./ttsTypes.ts";

export { TtsError as ElevenLabsTtsError, speechFailureReasonFor } from "./ttsTypes.ts";

const ELEVENLABS_API_URL = "https://api.elevenlabs.io";
const ELEVENLABS_TEXT_TO_SPEECH_URL = `${ELEVENLABS_API_URL}/v1/text-to-speech`;
const ELEVENLABS_MODELS_URL = `${ELEVENLABS_API_URL}/v1/models`;
const ELEVENLABS_VOICES_URL = `${ELEVENLABS_API_URL}/v2/voices?page_size=100`;
const ELEVENLABS_TEXT_TO_SPEECH_TIMEOUT = "120 seconds";
const ELEVENLABS_CATALOG_TIMEOUT = "15 seconds";
/**
 * ElevenLabs API list price per 1M characters for a model whose
 * `character_cost_multiplier` is 1 (Multilingual v2, v3). Flash and Turbo
 * report 0.5. Subscription credits price differently; this is the API rate.
 */
const ELEVENLABS_USD_PER_MILLION_CHARS_AT_MULTIPLIER_ONE = 100;

const ModelsBody = Schema.Array(
  Schema.Struct({
    model_id: Schema.String,
    name: Schema.optionalKey(Schema.String),
    can_do_text_to_speech: Schema.optionalKey(Schema.Boolean),
    maximum_text_length_per_request: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    model_rates: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          character_cost_multiplier: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        }),
      ),
    ),
  }),
);
const decodeModelsBody = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelsBody));

const VoicesBody = Schema.Struct({
  voices: Schema.Array(
    Schema.Struct({
      voice_id: Schema.String,
      name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
    }),
  ),
});
const decodeVoicesBody = Schema.decodeUnknownEffect(Schema.fromJsonString(VoicesBody));

export function toElevenLabsCatalogModel(entry: {
  readonly model_id: string;
  readonly name?: string | undefined;
  readonly maximum_text_length_per_request?: number | null | undefined;
  readonly model_rates?:
    | { readonly character_cost_multiplier?: number | null | undefined }
    | null
    | undefined;
}): TtsCatalogModel {
  const multiplier = entry.model_rates?.character_cost_multiplier ?? null;
  const maxInputChars = entry.maximum_text_length_per_request ?? null;
  return {
    id: entry.model_id,
    name: entry.name && entry.name.trim().length > 0 ? entry.name : entry.model_id,
    voices: null,
    maxInputChars:
      maxInputChars !== null && Number.isInteger(maxInputChars) && maxInputChars >= 0
        ? maxInputChars
        : null,
    priceUsdPerMillionChars:
      multiplier !== null && Number.isFinite(multiplier)
        ? multiplier * ELEVENLABS_USD_PER_MILLION_CHARS_AT_MULTIPLIER_ONE
        : null,
    priceUsdPerMillionAudioTokens: null,
    supportsInstructions: false,
  };
}

export function toElevenLabsCatalogVoice(entry: {
  readonly voice_id: string;
  readonly name?: string | null | undefined;
  readonly labels?: Readonly<Record<string, string>> | null | undefined;
}): TtsCatalogVoice {
  const detail = [entry.labels?.language, entry.labels?.gender, entry.labels?.accent]
    .map((value) => value?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" · ");
  return {
    id: entry.voice_id,
    name: entry.name && entry.name.trim().length > 0 ? entry.name.trim() : entry.voice_id,
    ...(detail.length > 0 ? { detail } : {}),
  };
}

const catalogError = (what: string) => () =>
  new TtsError({ reason: "request_failed", detail: `Could not load ElevenLabs ${what}.` });

const authorizedGet = (httpClient: HttpClient.HttpClient, url: string, apiKey: string) =>
  httpClient
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("xi-api-key", apiKey)))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.timeout(ELEVENLABS_CATALOG_TIMEOUT),
    );

/** Text-to-speech capable models on the account, name-sorted. */
export const listElevenLabsModels = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly apiKey: Redacted.Redacted<string>;
}): Effect.Effect<ReadonlyArray<TtsCatalogModel>, TtsError> =>
  authorizedGet(input.httpClient, ELEVENLABS_MODELS_URL, Redacted.value(input.apiKey)).pipe(
    Effect.flatMap(decodeModelsBody),
    Effect.map((models) =>
      models
        .filter((model) => model.can_do_text_to_speech !== false)
        .map(toElevenLabsCatalogModel)
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    ),
    Effect.mapError(catalogError("models")),
  );

/**
 * The account's voice library (first 100 entries; the library is the
 * user's own selection, so a larger one is unusual).
 */
export const listElevenLabsVoices = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly apiKey: Redacted.Redacted<string>;
}): Effect.Effect<ReadonlyArray<TtsCatalogVoice>, TtsError> =>
  authorizedGet(input.httpClient, ELEVENLABS_VOICES_URL, Redacted.value(input.apiKey)).pipe(
    Effect.flatMap(decodeVoicesBody),
    Effect.map((body) =>
      body.voices
        .map(toElevenLabsCatalogVoice)
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    ),
    Effect.mapError(catalogError("voices")),
  );

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
        errorStatus === "quota_exceeded"
          ? new TtsError({
              reason: "quota_exceeded",
              detail: "ElevenLabs refused the request: the account's character quota is used up.",
            })
          : new TtsError({
              reason: "request_failed",
              detail: `ElevenLabs answered with status ${response.status}${
                errorStatus === null ? "" : ` (${errorStatus})`
              }.`,
            }),
      ),
    ),
  );

const parseBilledCharacters = (header: string | undefined): number | null => {
  if (header === undefined) return null;
  const parsed = Number(header.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * One ElevenLabs text-to-speech request, shared by the on-demand listening
 * version, agent voice replies, and the settings test. Fails with `TtsError`
 * on any transport, status, or empty-body problem so callers can map it onto
 * their own error vocabulary. The `character-cost` response header is the
 * vendor's own count of billed characters.
 */
export const synthesizeElevenLabsSpeech = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly apiKey: Redacted.Redacted<string>;
  readonly voiceId: string;
  readonly ttsModel: string;
  readonly text: string;
}): Effect.Effect<SynthesizedSpeech, TtsError> =>
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
        ): Effect.Effect<
          { readonly buffer: ArrayBuffer; readonly billedCharacters: number | null },
          HttpClientError.HttpClientError | TtsError
        > =>
          response.status >= 200 && response.status < 300
            ? response.arrayBuffer.pipe(
                Effect.map((buffer) => ({
                  buffer,
                  billedCharacters: parseBilledCharacters(response.headers["character-cost"]),
                })),
              )
            : rejectedResponseError(response),
      ),
      Effect.timeout(ELEVENLABS_TEXT_TO_SPEECH_TIMEOUT),
      Effect.mapError((error) =>
        error._tag === "TtsError"
          ? error
          : new TtsError({
              reason: "request_failed",
              detail:
                error._tag === "TimeoutError"
                  ? "The ElevenLabs request timed out."
                  : "Could not reach ElevenLabs.",
            }),
      ),
      Effect.flatMap(({ buffer, billedCharacters }) => {
        const bytes = new Uint8Array(buffer);
        return bytes.byteLength === 0
          ? Effect.fail(
              new TtsError({ reason: "empty_audio", detail: "ElevenLabs returned no audio." }),
            )
          : Effect.succeed({
              bytes,
              mimeType: MP3_MIME_TYPE,
              cost: { usd: null, billedCharacters },
            } satisfies SynthesizedSpeech);
      }),
    );
