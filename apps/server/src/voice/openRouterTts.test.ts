import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/unstable/http";
import { describe, expect } from "vite-plus/test";

import {
  listOpenRouterSpeechModels,
  synthesizeOpenRouterSpeech,
  toOpenRouterCatalogModel,
} from "./openRouterTts.ts";
import { TtsError } from "./ttsTypes.ts";

const decodeRequestBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const apiKey = Redacted.make("test-key");

/** Routes by URL so one client can answer the speech and generation calls. */
const routed = (
  routes: Record<string, (request: { readonly body: string }) => Response>,
  seen: Array<{ readonly url: string; readonly body: string }> = [],
) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const query = UrlParams.toString(request.urlParams);
      seen.push({ url: query.length > 0 ? `${request.url}?${query}` : request.url, body });
      const route = Object.entries(routes).find(([prefix]) => request.url.startsWith(prefix));
      if (!route) throw new Error(`unrouted request: ${request.url}`);
      return HttpClientResponse.fromWeb(request, route[1]({ body }));
    }),
  );

describe("synthesizeOpenRouterSpeech", () => {
  it.effect("requests mp3 and reads the cost from the generation record", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly url: string; readonly body: string }> = [];
      const httpClient = routed(
        {
          "https://openrouter.ai/api/v1/audio/speech": () =>
            new Response(Uint8Array.from([9, 8, 7]), {
              headers: { "x-generation-id": "gen-1" },
            }),
          "https://openrouter.ai/api/v1/generation": () =>
            Response.json({ data: { id: "gen-1", total_cost: 0.00042 } }),
        },
        seen,
      );
      const synthesized = yield* synthesizeOpenRouterSpeech({
        httpClient,
        apiKey,
        modelId: "google/gemini-3.1-flash-tts-preview",
        voiceId: "Kore",
        instructions: "Speak warmly",
        text: "Hello there.",
        withCost: true,
      });
      expect(synthesized.bytes).toEqual(Uint8Array.from([9, 8, 7]));
      expect(synthesized.cost).toEqual({ usd: 0.00042, billedCharacters: null });

      expect(decodeRequestBody(seen[0]!.body)).toEqual({
        model: "google/gemini-3.1-flash-tts-preview",
        // Google models take direction inline; no provider options block.
        input: "Speak warmly: Hello there.",
        voice: "Kore",
        response_format: "mp3",
      });
      expect(seen[1]!.url).toContain("/api/v1/generation?id=gen-1");
    }),
  );

  it.effect("passes instructions as OpenAI provider options for other models", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly url: string; readonly body: string }> = [];
      const httpClient = routed(
        { "https://openrouter.ai/api/v1/audio/speech": () => new Response(Uint8Array.from([1])) },
        seen,
      );
      const synthesized = yield* synthesizeOpenRouterSpeech({
        httpClient,
        apiKey,
        modelId: "openai/gpt-4o-mini-tts",
        voiceId: "alloy",
        instructions: "Cheerful",
        text: "Hi.",
        withCost: false,
      });
      // No generation id and no cost lookup requested: cost stays unknown.
      expect(synthesized.cost).toEqual({ usd: null, billedCharacters: null });
      expect(seen).toHaveLength(1);
      expect(decodeRequestBody(seen[0]!.body)).toEqual({
        model: "openai/gpt-4o-mini-tts",
        input: "Hi.",
        voice: "alloy",
        response_format: "mp3",
        provider: { options: { openai: { instructions: "Cheerful" } } },
      });
    }),
  );

  it.live("leaves the cost unknown when the generation record never appears", () =>
    Effect.gen(function* () {
      const httpClient = routed({
        "https://openrouter.ai/api/v1/audio/speech": () =>
          new Response(Uint8Array.from([1]), { headers: { "x-generation-id": "gen-late" } }),
        "https://openrouter.ai/api/v1/generation": () =>
          Response.json({ error: { message: "not found" } }, { status: 404 }),
      });
      const synthesized = yield* synthesizeOpenRouterSpeech({
        httpClient,
        apiKey,
        modelId: "google/gemini-3.1-flash-tts-preview",
        voiceId: "Kore",
        text: "Hi.",
        withCost: true,
      });
      expect(synthesized.bytes).toEqual(Uint8Array.from([1]));
      expect(synthesized.cost.usd).toBeNull();
    }),
  );

  it.effect("maps an out-of-credits rejection to quota_exceeded", () =>
    Effect.gen(function* () {
      const failure = yield* synthesizeOpenRouterSpeech({
        httpClient: routed({
          "https://openrouter.ai/api/v1/audio/speech": () =>
            Response.json({ error: { message: "Insufficient credits" } }, { status: 402 }),
        }),
        apiKey,
        modelId: "google/gemini-3.1-flash-tts-preview",
        voiceId: "Kore",
        text: "Hi.",
        withCost: false,
      }).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(TtsError);
      expect(failure.reason).toBe("quota_exceeded");

      const badRequest = yield* synthesizeOpenRouterSpeech({
        httpClient: routed({
          "https://openrouter.ai/api/v1/audio/speech": () =>
            Response.json({ error: { message: "Unknown voice" } }, { status: 400 }),
        }),
        apiKey,
        modelId: "google/gemini-3.1-flash-tts-preview",
        voiceId: "Nope",
        text: "Hi.",
        withCost: false,
      }).pipe(Effect.flip);
      expect(badRequest.reason).toBe("request_failed");
      expect(badRequest.detail).toContain("Unknown voice");
    }),
  );

  it.effect("omits OpenAI-specific instructions for unsupported model families", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly url: string; readonly body: string }> = [];
      yield* synthesizeOpenRouterSpeech({
        httpClient: routed(
          { "https://openrouter.ai/api/v1/audio/speech": () => new Response(Uint8Array.from([1])) },
          seen,
        ),
        apiKey,
        modelId: "deepgram/aura-2",
        voiceId: "asteria",
        instructions: "Cheerful",
        text: "Hi.",
        withCost: false,
      });
      expect(decodeRequestBody(seen[0]!.body)).toEqual({
        model: "deepgram/aura-2",
        input: "Hi.",
        voice: "asteria",
        response_format: "mp3",
      });
    }),
  );
});

describe("OpenRouter speech catalog", () => {
  it("derives per-million prices and keeps the voice list", () => {
    expect(
      toOpenRouterCatalogModel({
        id: "google/gemini-3.1-flash-tts-preview",
        name: "Google: Gemini 3.1 Flash TTS Preview",
        pricing: { prompt: "0.000001", completion: "0.00002" },
        supported_voices: ["Kore", "Puck"],
      }),
    ).toEqual({
      id: "google/gemini-3.1-flash-tts-preview",
      name: "Google: Gemini 3.1 Flash TTS Preview",
      voices: [
        { id: "Kore", name: "Kore" },
        { id: "Puck", name: "Puck" },
      ],
      maxInputChars: null,
      priceUsdPerMillionChars: 1,
      priceUsdPerMillionAudioTokens: 20,
      supportsInstructions: true,
    });
    // A zero completion price is "not token priced", not a free output.
    expect(
      toOpenRouterCatalogModel({
        id: "deepgram/aura-2",
        pricing: { prompt: "0.00003", completion: "0" },
      }).priceUsdPerMillionAudioTokens,
    ).toBeNull();
    expect(toOpenRouterCatalogModel({ id: "deepgram/aura-2" }).supportsInstructions).toBe(false);
  });

  it.effect("lists models from the speech-filtered endpoint, name-sorted", () =>
    Effect.gen(function* () {
      const models = yield* listOpenRouterSpeechModels({
        httpClient: routed({
          "https://openrouter.ai/api/v1/models": () =>
            Response.json({
              data: [
                { id: "z/late", name: "Zed", pricing: { prompt: "0.00001", completion: "0" } },
                { id: "a/early", name: "Alpha", supported_voices: ["v1"] },
              ],
            }),
        }),
        apiKey,
      });
      expect(models.map((model) => model.id)).toEqual(["a/early", "z/late"]);
      expect(models[0]!.voices).toEqual([{ id: "v1", name: "v1" }]);
      expect(models[0]!.priceUsdPerMillionChars).toBeNull();
    }),
  );
});
