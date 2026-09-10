import type { TtsCatalogModel, TtsCatalogVoice } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  type HttpClientError,
} from "effect/unstable/http";

import { SPEECH_MIME_TYPE } from "./elevenLabsTts.ts";
import { TtsError, type SynthesizedSpeech } from "./ttsTypes.ts";

const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";
const OPENROUTER_SPEECH_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=speech";
const OPENROUTER_GENERATION_URL = "https://openrouter.ai/api/v1/generation";
const OPENROUTER_SPEECH_TIMEOUT = "120 seconds";
const OPENROUTER_CATALOG_TIMEOUT = "15 seconds";
/**
 * Generation metadata is written asynchronously after the audio bytes land,
 * so the first read can 404. Two short retries cover the usual lag without
 * holding the caller for long; a still-missing record leaves the cost null.
 */
const OPENROUTER_GENERATION_ATTEMPTS = 3;
const OPENROUTER_GENERATION_RETRY_DELAY = "400 millis";
const OPENROUTER_GENERATION_TIMEOUT = "5 seconds";

/**
 * OpenRouter's speech endpoint accepts a per-provider `instructions` for
 * OpenAI models only. Google's TTS models take style direction as part of
 * the input text instead, so the instruction is folded into the prompt for
 * them (their docs show exactly this "Say cheerfully: ..." form).
 */
export type OpenRouterInstructionMode = "prompt" | "openai" | "none";

export function getOpenRouterInstructionMode(modelId: string): OpenRouterInstructionMode {
  if (modelId.startsWith("google/")) return "prompt";
  if (modelId.startsWith("openai/")) return "openai";
  return "none";
}

const SpeechModelsBody = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optionalKey(Schema.String),
      context_length: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      pricing: Schema.optionalKey(
        Schema.Struct({
          prompt: Schema.optionalKey(Schema.String),
          completion: Schema.optionalKey(Schema.String),
        }),
      ),
      supported_voices: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    }),
  ),
});
const decodeSpeechModelsBody = Schema.decodeUnknownEffect(Schema.fromJsonString(SpeechModelsBody));

const GenerationBody = Schema.Struct({
  data: Schema.Struct({
    total_cost: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  }),
});
const decodeGenerationBody = Schema.decodeUnknownEffect(Schema.fromJsonString(GenerationBody));

const parseUsdPerUnit = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * OpenRouter quotes `pricing.prompt` per input character for speech models
 * and `pricing.completion` per output audio token (only Gemini sets it).
 */
export function toOpenRouterCatalogModel(entry: {
  readonly id: string;
  readonly name?: string | undefined;
  readonly context_length?: number | null | undefined;
  readonly pricing?:
    | { readonly prompt?: string | undefined; readonly completion?: string | undefined }
    | undefined;
  readonly supported_voices?: ReadonlyArray<string> | null | undefined;
}): TtsCatalogModel {
  const promptPrice = parseUsdPerUnit(entry.pricing?.prompt);
  const completionPrice = parseUsdPerUnit(entry.pricing?.completion);
  const voices: ReadonlyArray<TtsCatalogVoice> = (entry.supported_voices ?? []).map((id) => ({
    id,
    name: id,
  }));
  return {
    id: entry.id,
    name: entry.name && entry.name.trim().length > 0 ? entry.name : entry.id,
    voices,
    maxInputChars: null,
    priceUsdPerMillionChars: promptPrice === null ? null : promptPrice * 1_000_000,
    priceUsdPerMillionAudioTokens:
      completionPrice === null || completionPrice === 0 ? null : completionPrice * 1_000_000,
    supportsInstructions: getOpenRouterInstructionMode(entry.id) !== "none",
  };
}

export const listOpenRouterSpeechModels = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly apiKey: Redacted.Redacted<string>;
}): Effect.Effect<ReadonlyArray<TtsCatalogModel>, TtsError> =>
  input.httpClient
    .execute(
      HttpClientRequest.get(OPENROUTER_SPEECH_MODELS_URL).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(input.apiKey)}`),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.flatMap(decodeSpeechModelsBody),
      Effect.map((body) =>
        body.data
          .map(toOpenRouterCatalogModel)
          .toSorted((left, right) => left.name.localeCompare(right.name)),
      ),
      Effect.timeout(OPENROUTER_CATALOG_TIMEOUT),
      Effect.mapError(
        () =>
          new TtsError({ reason: "request_failed", detail: "Could not load OpenRouter models." }),
      ),
    );

const rejectedResponseError = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.tap(() =>
      Effect.logWarning("openrouter text-to-speech request rejected", {
        status: response.status,
      }),
    ),
    Effect.flatMap((body) =>
      Effect.fail(
        response.status === 402
          ? new TtsError({
              reason: "quota_exceeded",
              detail: "OpenRouter refused the request: the account is out of credits.",
            })
          : new TtsError({
              reason: "request_failed",
              detail: openRouterErrorDetail(body, response.status),
            }),
      ),
    ),
  );

/** The `error.message` of an OpenRouter error body, or a status fallback. */
const openRouterErrorDetail = (body: string, status: number): string => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const error = parsed.error;
      if (typeof error === "object" && error !== null && "message" in error) {
        const message = error.message;
        if (typeof message === "string" && message.trim().length > 0) {
          return `OpenRouter answered with status ${status}: ${message.trim()}`;
        }
      }
    }
  } catch {
    // Not JSON; fall through to the status-only text.
  }
  return `OpenRouter answered with status ${status}.`;
};

/**
 * Best-effort cost lookup for one generation. Never fails: a missing or
 * late record leaves the cost unknown rather than failing a synthesis that
 * already produced audio.
 */
const readGenerationCost = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly apiKey: Redacted.Redacted<string>;
  readonly generationId: string;
}): Effect.Effect<number | null> =>
  input.httpClient
    .execute(
      HttpClientRequest.get(OPENROUTER_GENERATION_URL).pipe(
        HttpClientRequest.setUrlParam("id", input.generationId),
        HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(input.apiKey)}`),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.flatMap(decodeGenerationBody),
      Effect.map((body) => body.data.total_cost ?? null),
      Effect.timeout(OPENROUTER_GENERATION_TIMEOUT),
      Effect.retry(
        Schedule.recurs(OPENROUTER_GENERATION_ATTEMPTS - 1).pipe(
          Schedule.addDelay(() => Effect.succeed(OPENROUTER_GENERATION_RETRY_DELAY)),
        ),
      ),
      Effect.orElseSucceed((): number | null => null),
    );

/**
 * One OpenRouter speech request. Every model on the endpoint returns MP3 when
 * asked, which keeps the persisted attachment contract (`audio/mpeg`) intact.
 * The cost is read from the generation record the response header names.
 */
export const synthesizeOpenRouterSpeech = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly apiKey: Redacted.Redacted<string>;
  readonly modelId: string;
  readonly voiceId: string;
  readonly instructions?: string | undefined;
  readonly text: string;
  /** Whether to read the generation record for cost after synthesis. */
  readonly withCost: boolean;
}): Effect.Effect<SynthesizedSpeech, TtsError> =>
  Effect.gen(function* () {
    const instructions = input.instructions?.trim();
    const instructionMode = getOpenRouterInstructionMode(input.modelId);
    const foldInstructions =
      instructions !== undefined && instructions.length > 0 && instructionMode === "prompt";
    const providerOptions =
      instructions !== undefined && instructions.length > 0 && instructionMode === "openai"
        ? { provider: { options: { openai: { instructions } } } }
        : {};
    const response = yield* input.httpClient
      .post(OPENROUTER_SPEECH_URL, {
        headers: { Authorization: `Bearer ${Redacted.value(input.apiKey)}` },
        body: HttpBody.jsonUnsafe({
          model: input.modelId,
          input: foldInstructions ? `${instructions}: ${input.text}` : input.text,
          voice: input.voiceId,
          response_format: "mp3",
          ...providerOptions,
        }),
      })
      .pipe(Effect.timeout(OPENROUTER_SPEECH_TIMEOUT));
    if (response.status < 200 || response.status >= 300) {
      return yield* rejectedResponseError(response);
    }
    const generationId = response.headers["x-generation-id"]?.trim() || undefined;
    const buffer = yield* response.arrayBuffer.pipe(Effect.timeout(OPENROUTER_SPEECH_TIMEOUT));
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength === 0) {
      return yield* new TtsError({
        reason: "empty_audio",
        detail: "OpenRouter returned no audio.",
      });
    }
    const usd =
      input.withCost && generationId !== undefined
        ? yield* readGenerationCost({
            httpClient: input.httpClient,
            apiKey: input.apiKey,
            generationId,
          })
        : null;
    return {
      bytes,
      mimeType: SPEECH_MIME_TYPE,
      cost: { usd, billedCharacters: null },
    } satisfies SynthesizedSpeech;
  }).pipe(
    Effect.mapError(
      (error: TtsError | HttpClientError.HttpClientError | { readonly _tag: "TimeoutError" }) =>
        error._tag === "TtsError"
          ? error
          : new TtsError({
              reason: "request_failed",
              detail:
                error._tag === "TimeoutError"
                  ? "The OpenRouter request timed out."
                  : "Could not reach OpenRouter.",
            }),
    ),
  );
