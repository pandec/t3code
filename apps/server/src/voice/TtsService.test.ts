import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { layer, OPENROUTER_TTS_API_KEY_SECRET_NAME, TtsService } from "./TtsService.ts";

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
