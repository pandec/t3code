import { MESSAGE_SPEECH_MAX_SOURCE_CHARS } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ELEVENLABS_TTS_MODEL,
  DEFAULT_ELEVENLABS_TTS_VOICE_ID,
  getElevenLabsTtsCharacterLimit,
  isMessageSpeechCacheReusable,
  isMessageSpeechSourceEligible,
  makeMessageSpeechLockCoordinator,
  resolveMessageSpeechVoiceSetting,
} from "./MessageSpeech.ts";

describe("message speech locking", () => {
  effectIt.effect("serializes the same message and evicts locks after success or failure", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeMessageSpeechLockCoordinator();
      const active = yield* Ref.make(0);
      const maxActive = yield* Ref.make(0);
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();

      const first = yield* Effect.forkChild(
        coordinator.withMessageLock(
          "message",
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(active, (value) => value + 1);
            yield* Ref.update(maxActive, (value) => Math.max(value, count));
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
            yield* Ref.update(active, (value) => value - 1);
          }),
        ),
      );
      yield* Deferred.await(firstStarted);

      const second = yield* Effect.forkChild(
        coordinator.withMessageLock(
          "message",
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(active, (value) => value + 1);
            yield* Ref.update(maxActive, (value) => Math.max(value, count));
            yield* Deferred.succeed(secondStarted, undefined);
            yield* Ref.update(active, (value) => value - 1);
          }),
        ),
      );
      yield* Effect.yieldNow;
      expect(Option.isNone(yield* Deferred.poll(secondStarted))).toBe(true);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Deferred.await(secondStarted);

      expect(yield* Ref.get(maxActive)).toBe(1);
      expect(yield* coordinator.activeLockCount).toBe(0);

      yield* coordinator.withMessageLock("missing", Effect.fail("boom")).pipe(Effect.result);
      expect(yield* coordinator.activeLockCount).toBe(0);
    }),
  );
});

describe("message speech eligibility", () => {
  it("accepts only completed, non-empty assistant responses within the source limit", () => {
    expect(
      isMessageSpeechSourceEligible({ role: "assistant", isStreaming: false, text: "Response" }),
    ).toBe(true);
    expect(
      isMessageSpeechSourceEligible({ role: "user", isStreaming: false, text: "Response" }),
    ).toBe(false);
    expect(
      isMessageSpeechSourceEligible({ role: "assistant", isStreaming: true, text: "Response" }),
    ).toBe(false);
    expect(
      isMessageSpeechSourceEligible({ role: "assistant", isStreaming: false, text: "   " }),
    ).toBe(false);
    expect(
      isMessageSpeechSourceEligible({
        role: "assistant",
        isStreaming: false,
        text: "x".repeat(MESSAGE_SPEECH_MAX_SOURCE_CHARS + 1),
      }),
    ).toBe(false);
    expect(
      isMessageSpeechSourceEligible({
        role: "assistant",
        isStreaming: false,
        text: "x".repeat(5_001),
        maxSourceChars: 5_000,
      }),
    ).toBe(false);
  });
});

describe("ElevenLabs TTS character limits", () => {
  it("uses the documented limit for each configurable model family", () => {
    expect(getElevenLabsTtsCharacterLimit("eleven_flash_v2_5")).toBe(40_000);
    expect(getElevenLabsTtsCharacterLimit("eleven_flash_v2")).toBe(30_000);
    expect(getElevenLabsTtsCharacterLimit("eleven_multilingual_v2")).toBe(10_000);
    expect(getElevenLabsTtsCharacterLimit("eleven_v3")).toBe(5_000);
    expect(getElevenLabsTtsCharacterLimit("future_model")).toBe(5_000);
  });
});

describe("TTS model and voice resolution", () => {
  it("prefers the server setting, then the environment, then the default", () => {
    expect(resolveMessageSpeechVoiceSetting("eleven_v3", "eleven_turbo_v2")).toBe("eleven_v3");
    expect(resolveMessageSpeechVoiceSetting("", "eleven_turbo_v2")).toBe("eleven_turbo_v2");
    expect(resolveMessageSpeechVoiceSetting(undefined, DEFAULT_ELEVENLABS_TTS_MODEL)).toBe(
      DEFAULT_ELEVENLABS_TTS_MODEL,
    );
    expect(resolveMessageSpeechVoiceSetting(null, DEFAULT_ELEVENLABS_TTS_VOICE_ID)).toBe(
      DEFAULT_ELEVENLABS_TTS_VOICE_ID,
    );
  });

  it("treats a whitespace-only setting as unset and trims the rest", () => {
    expect(resolveMessageSpeechVoiceSetting("   ", "env-voice")).toBe("env-voice");
    expect(resolveMessageSpeechVoiceSetting("  voice-a  ", "env-voice")).toBe("voice-a");
  });
});

describe("message speech cache identity", () => {
  const cache = {
    sourceTextHash: "hash",
    scriptRecipeHash: "recipe",
    voiceId: "voice",
    ttsModel: "model",
    mimeType: "audio/mpeg",
  };

  it("reuses audio only when source, voice, model, and format still match", () => {
    expect(
      isMessageSpeechCacheReusable({
        cache,
        sourceTextHash: "hash",
        scriptRecipeHash: "recipe",
        voiceId: "voice",
        ttsModel: "model",
      }),
    ).toBe(true);
    expect(
      isMessageSpeechCacheReusable({
        cache,
        sourceTextHash: "changed",
        scriptRecipeHash: "recipe",
        voiceId: "voice",
        ttsModel: "model",
      }),
    ).toBe(false);
    expect(
      isMessageSpeechCacheReusable({
        cache,
        sourceTextHash: "hash",
        scriptRecipeHash: "recipe",
        voiceId: "other",
        ttsModel: "model",
      }),
    ).toBe(false);
    expect(
      isMessageSpeechCacheReusable({
        cache,
        sourceTextHash: "hash",
        scriptRecipeHash: "recipe",
        voiceId: "voice",
        ttsModel: "other",
      }),
    ).toBe(false);
    expect(
      isMessageSpeechCacheReusable({
        cache,
        sourceTextHash: "hash",
        scriptRecipeHash: "changed",
        voiceId: "voice",
        ttsModel: "model",
      }),
    ).toBe(false);
  });
});
