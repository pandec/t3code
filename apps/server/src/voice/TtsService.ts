import type {
  TtsCatalogResult,
  TtsProfile,
  TtsProvider,
  TtsProviderStatus,
  TtsStatusResult,
  TtsTestResult,
} from "@t3tools/contracts";
import { TtsRpcError, TTS_PROVIDER_LABELS } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  listElevenLabsModels,
  listElevenLabsVoices,
  synthesizeElevenLabsSpeech,
} from "./elevenLabsTts.ts";
import { listOpenRouterSpeechModels, synthesizeOpenRouterSpeech } from "./openRouterTts.ts";
import {
  getTtsCharacterLimit,
  readTtsEnvironmentDefaults,
  type TtsEnvironmentDefaults,
} from "./ttsProfile.ts";
import { TtsError, type SynthesizedSpeech } from "./ttsTypes.ts";

/**
 * Secret-store name for the OpenRouter inference key used by speech. Kept
 * apart from the credits reader's management key: OpenRouter rejects
 * management keys on inference routes and inference keys on the credits
 * route, so one key cannot serve both.
 */
export const OPENROUTER_TTS_API_KEY_SECRET_NAME = "openrouter-tts-api-key";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface TtsServiceShape {
  /** Environment fallbacks for model and voice, read once at startup. */
  readonly environmentDefaults: TtsEnvironmentDefaults;
  /** Whether the named provider currently has a usable key. */
  readonly isConfigured: (provider: TtsProvider) => Effect.Effect<boolean>;
  /** Whether any provider is configured: gates the listen and voice_reply features. */
  readonly anyConfigured: Effect.Effect<boolean>;
  /** Re-emits after a key is stored or removed, so config snapshots can refresh. */
  readonly configuredChanges: Stream.Stream<void>;
  readonly status: Effect.Effect<TtsStatusResult>;
  readonly catalog: (provider: TtsProvider) => Effect.Effect<TtsCatalogResult>;
  readonly configureOpenRouter: (
    apiKey: string,
  ) => Effect.Effect<{ configured: boolean }, TtsRpcError>;
  readonly synthesize: (input: {
    readonly profile: TtsProfile;
    readonly text: string;
    /** Read the vendor's cost record after synthesis (test dialog only). */
    readonly withCost?: boolean;
  }) => Effect.Effect<SynthesizedSpeech, TtsError>;
  readonly test: (input: {
    readonly profile: TtsProfile;
    readonly text: string;
  }) => Effect.Effect<TtsTestResult, TtsRpcError>;
}

export class TtsService extends Context.Service<TtsService, TtsServiceShape>()(
  "t3/voice/TtsService",
) {}

const unavailableError = (provider: TtsProvider) =>
  new TtsError({
    reason: "request_failed",
    detail: `${TTS_PROVIDER_LABELS[provider]} is not configured on this server.`,
  });

export const layer = Layer.effect(
  TtsService,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const environmentDefaults = yield* readTtsEnvironmentDefaults;
    const elevenLabsKey = yield* Config.redacted("ELEVENLABS_API_KEY").pipe(
      Config.option,
      Effect.map(Option.filter((key) => Redacted.value(key).trim().length > 0)),
      Effect.orDie,
    );
    const configuredChanges = yield* PubSub.unbounded<void>();

    const readOpenRouterKey: Effect.Effect<
      Option.Option<Redacted.Redacted<string>>,
      ServerSecretStore.SecretStoreError
    > = secretStore.get(OPENROUTER_TTS_API_KEY_SECRET_NAME).pipe(
      Effect.map((stored) =>
        Option.flatMap(stored, (bytes) => {
          const key = textDecoder.decode(bytes).trim();
          return key.length > 0 ? Option.some(Redacted.make(key)) : Option.none();
        }),
      ),
    );

    const readKey = (
      provider: TtsProvider,
    ): Effect.Effect<
      Option.Option<Redacted.Redacted<string>>,
      ServerSecretStore.SecretStoreError
    > => (provider === "elevenlabs" ? Effect.succeed(elevenLabsKey) : readOpenRouterKey);

    const providerStatus = (provider: TtsProvider): Effect.Effect<TtsProviderStatus> =>
      readKey(provider).pipe(
        Effect.map((key) => ({ configured: Option.isSome(key) })),
        Effect.catch((error) =>
          Effect.logWarning("Failed to read a text-to-speech API key.", {
            provider,
            cause: error,
          }).pipe(
            Effect.as({
              configured: false,
              error: `Could not read the stored ${TTS_PROVIDER_LABELS[provider]} key.`,
            }),
          ),
        ),
      );

    const isConfigured = (provider: TtsProvider) =>
      providerStatus(provider).pipe(Effect.map((status) => status.configured));

    const anyConfigured = Effect.gen(function* () {
      if (Option.isSome(elevenLabsKey)) return true;
      return yield* isConfigured("openrouter");
    });

    const status: Effect.Effect<TtsStatusResult> = Effect.gen(function* () {
      return {
        elevenlabs: yield* providerStatus("elevenlabs"),
        openrouter: yield* providerStatus("openrouter"),
      };
    });

    const catalog = (provider: TtsProvider): Effect.Effect<TtsCatalogResult> =>
      Effect.gen(function* () {
        const key = yield* readKey(provider).pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(key)) {
          return { provider, configured: false, models: [], voices: [] };
        }
        const apiKey = key.value;
        if (provider === "elevenlabs") {
          const [models, voices] = yield* Effect.all(
            [
              listElevenLabsModels({ httpClient, apiKey }),
              listElevenLabsVoices({ httpClient, apiKey }),
            ],
            { concurrency: 2 },
          );
          return { provider, configured: true, models, voices };
        }
        const models = yield* listOpenRouterSpeechModels({ httpClient, apiKey });
        return { provider, configured: true, models, voices: [] };
      }).pipe(
        Effect.catch((error: TtsError) =>
          Effect.succeed({
            provider,
            configured: true,
            models: [],
            voices: [],
            error: error.detail,
          }),
        ),
      );

    const configureOpenRouter = (apiKey: string) =>
      Effect.gen(function* () {
        const trimmed = apiKey.trim();
        if (trimmed.length === 0) {
          yield* secretStore.remove(OPENROUTER_TTS_API_KEY_SECRET_NAME);
        } else {
          yield* secretStore.set(OPENROUTER_TTS_API_KEY_SECRET_NAME, textEncoder.encode(trimmed));
        }
        yield* PubSub.publish(configuredChanges, undefined);
        return { configured: trimmed.length > 0 };
      }).pipe(
        Effect.mapError(
          () =>
            new TtsRpcError({
              reason: "unavailable",
              detail: "Could not update the stored OpenRouter key.",
            }),
        ),
      );

    const synthesize: TtsServiceShape["synthesize"] = Effect.fn("TtsService.synthesize")(
      function* (input) {
        const key = yield* readKey(input.profile.provider).pipe(
          Effect.mapError(
            () =>
              new TtsError({
                reason: "request_failed",
                detail: `Could not read the stored ${TTS_PROVIDER_LABELS[input.profile.provider]} key.`,
              }),
          ),
        );
        if (Option.isNone(key)) {
          return yield* unavailableError(input.profile.provider);
        }
        if (input.profile.provider === "elevenlabs") {
          return yield* synthesizeElevenLabsSpeech({
            httpClient,
            apiKey: key.value,
            voiceId: input.profile.voiceId,
            ttsModel: input.profile.modelId,
            text: input.text,
          });
        }
        return yield* synthesizeOpenRouterSpeech({
          httpClient,
          apiKey: key.value,
          modelId: input.profile.modelId,
          voiceId: input.profile.voiceId,
          instructions: input.profile.instructions,
          text: input.text,
          withCost: input.withCost === true,
        });
      },
    );

    const test: TtsServiceShape["test"] = Effect.fn("TtsService.test")(function* (input) {
      const text = input.text.trim();
      if (text.length > getTtsCharacterLimit(input.profile)) {
        return yield* new TtsRpcError({
          reason: "text_too_long",
          detail: "The sample is longer than this model accepts in one request.",
        });
      }
      const synthesized = yield* synthesize({ profile: input.profile, text, withCost: true }).pipe(
        Effect.mapError(
          (error) =>
            new TtsRpcError({
              reason:
                error.reason === "quota_exceeded" ? "provider_quota_exceeded" : "provider_failed",
              detail: error.detail,
            }),
        ),
      );
      return {
        mimeType: synthesized.mimeType,
        audioBase64: Encoding.encodeBase64(synthesized.bytes),
        sizeBytes: synthesized.bytes.byteLength,
        characterCount: text.length,
        cost: synthesized.cost,
      } satisfies TtsTestResult;
    });

    return TtsService.of({
      environmentDefaults,
      isConfigured,
      anyConfigured,
      configuredChanges: Stream.fromPubSub(configuredChanges),
      status,
      catalog,
      configureOpenRouter,
      synthesize,
      test,
    });
  }),
);

/** Inert instance for tests and harnesses that do not exercise speech. */
export const layerNoop = Layer.succeed(
  TtsService,
  TtsService.of({
    environmentDefaults: {
      elevenlabs: { modelId: "eleven_flash_v2_5", voiceId: "JBFqnCBsd6RMkjVDRZzb" },
      openrouter: { modelId: "google/gemini-3.1-flash-tts-preview", voiceId: "Kore" },
    },
    isConfigured: () => Effect.succeed(false),
    anyConfigured: Effect.succeed(false),
    configuredChanges: Stream.empty,
    status: Effect.succeed({
      elevenlabs: { configured: false },
      openrouter: { configured: false },
    }),
    catalog: (provider) => Effect.succeed({ provider, configured: false, models: [], voices: [] }),
    configureOpenRouter: () =>
      Effect.fail(new TtsRpcError({ reason: "unavailable", detail: "Speech is not configured." })),
    synthesize: () =>
      Effect.fail(new TtsError({ reason: "request_failed", detail: "Speech is not configured." })),
    test: () =>
      Effect.fail(new TtsRpcError({ reason: "unavailable", detail: "Speech is not configured." })),
  }),
);
