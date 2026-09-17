import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { SPEECH_CHUNK_MAX_CHARS } from "./speechChunks.ts";
import {
  joinSynthesizedSpeech,
  layer,
  OPENROUTER_TTS_API_KEY_SECRET_NAME,
  TtsService,
} from "./TtsService.ts";
import { wrapPcmAsWav } from "./wavAudio.ts";

const decodeRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ input: Schema.String })),
);
const mono24k = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 };

const configuredOpenRouter = (httpClient: HttpClient.HttpClient) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          ServerSecretStore,
          ServerSecretStore.of({
            get: (name) =>
              Effect.succeed(
                name === OPENROUTER_TTS_API_KEY_SECRET_NAME
                  ? Option.some(new TextEncoder().encode("inference-secret"))
                  : Option.none(),
              ),
            set: () => Effect.void,
            remove: () => Effect.void,
            create: () => Effect.void,
            getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
          }),
        ),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
      ),
    ),
  );

const openRouterProfile = {
  provider: "openrouter" as const,
  modelId: "google/gemini-3.1-flash-tts-preview",
  voiceId: "Kore",
};

const paragraph = (marker: number) =>
  `Paragraph ${marker} ${"x".repeat(SPEECH_CHUNK_MAX_CHARS - 40)}.`;

it.effect("synthesizes a long OpenRouter script as parallel pieces joined in order", () =>
  Effect.gen(function* () {
    // Three pieces, each answered only once all three requests are in flight,
    // so a sequential implementation would deadlock here instead of passing.
    const script = [paragraph(1), paragraph(2), paragraph(3)].join("\n\n");
    const inFlight = yield* Ref.make(0);
    const allStarted = yield* Deferred.make<void>();
    const httpClient = HttpClient.make((request) =>
      Effect.gen(function* () {
        const body = decodeRequestBody(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        const marker = Number(/Paragraph (\d)/.exec(body.input)?.[1]);
        if ((yield* Ref.updateAndGet(inFlight, (count) => count + 1)) === 3) {
          yield* Deferred.succeed(allStarted, undefined);
        }
        yield* Deferred.await(allStarted);
        return HttpClientResponse.fromWeb(
          request,
          new Response(Uint8Array.from([marker, marker]), {
            headers: { "content-type": "audio/pcm;rate=24000;channels=1" },
          }),
        );
      }),
    );
    const tts = yield* TtsService.pipe(Effect.provide(configuredOpenRouter(httpClient)));
    const synthesized = yield* tts.synthesize({ profile: openRouterProfile, text: script });
    expect(synthesized.mimeType).toBe("audio/wav");
    expect(synthesized.bytes).toEqual(wrapPcmAsWav(Uint8Array.from([1, 1, 2, 2, 3, 3]), mono24k));
    expect(synthesized.cost).toEqual({ usd: null, billedCharacters: null });
  }),
);

it.effect("sends a short OpenRouter script as one request", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        return HttpClientResponse.fromWeb(
          request,
          new Response(Uint8Array.from([7, 7]), {
            headers: { "content-type": "audio/pcm;rate=24000;channels=1" },
          }),
        );
      }),
    );
    const tts = yield* TtsService.pipe(Effect.provide(configuredOpenRouter(httpClient)));
    const synthesized = yield* tts.synthesize({
      profile: openRouterProfile,
      text: "  One short sentence.  ",
    });
    expect(requests.map((body) => decodeRequestBody(body).input)).toEqual(["One short sentence."]);
    expect(synthesized.bytes).toEqual(wrapPcmAsWav(Uint8Array.from([7, 7]), mono24k));
  }),
);

it.effect("joins piece costs and refuses mixed containers", () =>
  Effect.gen(function* () {
    const joined = yield* joinSynthesizedSpeech([
      {
        bytes: wrapPcmAsWav(Uint8Array.from([1, 1]), mono24k),
        mimeType: "audio/wav",
        cost: { usd: 0.001, billedCharacters: 10 },
      },
      {
        bytes: wrapPcmAsWav(Uint8Array.from([2, 2]), mono24k),
        mimeType: "audio/wav",
        cost: { usd: 0.002, billedCharacters: 20 },
      },
    ]);
    expect(joined.bytes).toEqual(wrapPcmAsWav(Uint8Array.from([1, 1, 2, 2]), mono24k));
    expect(joined.cost).toEqual({ usd: 0.003, billedCharacters: 30 });

    // One unknown cost makes the total unknown rather than understated.
    const partial = yield* joinSynthesizedSpeech([
      {
        bytes: wrapPcmAsWav(Uint8Array.from([1, 1]), mono24k),
        mimeType: "audio/wav",
        cost: { usd: 0.001, billedCharacters: null },
      },
      {
        bytes: wrapPcmAsWav(Uint8Array.from([2, 2]), mono24k),
        mimeType: "audio/wav",
        cost: { usd: null, billedCharacters: 20 },
      },
    ]);
    expect(partial.cost).toEqual({ usd: null, billedCharacters: null });

    expect(
      yield* joinSynthesizedSpeech([
        {
          bytes: wrapPcmAsWav(Uint8Array.from([1, 1]), mono24k),
          mimeType: "audio/wav",
          cost: { usd: null, billedCharacters: null },
        },
        {
          bytes: Uint8Array.from([0xff, 0xfb]),
          mimeType: "audio/mpeg",
          cost: { usd: null, billedCharacters: null },
        },
      ]).pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { reason: "request_failed" } });
    expect(yield* joinSynthesizedSpeech([]).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "empty_audio" },
    });
  }),
);

it.effect("publishes key changes and reports effective defaults without exposing secrets", () =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    const secrets = Layer.succeed(
      ServerSecretStore,
      ServerSecretStore.of({
        get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
        set: (name, bytes) =>
          Effect.sync(() => {
            stored.set(name, bytes);
          }),
        remove: (name) =>
          Effect.sync(() => {
            stored.delete(name);
          }),
        create: () => Effect.void,
        getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      }),
    );
    yield* Effect.gen(function* () {
      const tts = yield* TtsService;
      const changes = yield* Stream.toPull(tts.configuredChanges);
      const initial = yield* tts.status;
      expect(initial.elevenlabs.configured).toBe(true);
      expect(initial.openrouter.configured).toBe(false);
      expect(initial.openrouter.defaults).toEqual({ modelId: "custom/model", voiceId: "Kore" });
      expect(
        yield* tts
          .test({
            profile: { provider: "openrouter", modelId: "custom/model", voiceId: "Kore" },
            text: "test",
          })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } });
      const configured = yield* Effect.forkChild(changes, { startImmediately: true });
      expect(yield* tts.configureOpenRouter(" inference-secret ")).toEqual({ configured: true });
      yield* Fiber.join(configured);
      expect(new TextDecoder().decode(stored.get(OPENROUTER_TTS_API_KEY_SECRET_NAME))).toBe(
        "inference-secret",
      );
      expect(yield* tts.isConfigured("openrouter")).toBe(true);
      const status = yield* tts.status;
      expect(Object.keys(status.openrouter)).toEqual(["configured", "defaults"]);
      const removed = yield* Effect.forkChild(changes, { startImmediately: true });
      yield* tts.configureOpenRouter("");
      yield* Fiber.join(removed);
      expect(yield* tts.isConfigured("openrouter")).toBe(false);
      expect(stored.has(OPENROUTER_TTS_API_KEY_SECRET_NAME)).toBe(false);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              secrets,
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("Unexpected HTTP request")),
              ),
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    ELEVENLABS_API_KEY: "eleven-secret",
                    OPENROUTER_TTS_MODEL: " custom/model ",
                    OPENROUTER_TTS_VOICE_ID: " ",
                  },
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
