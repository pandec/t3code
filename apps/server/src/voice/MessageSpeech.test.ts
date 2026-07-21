import { MESSAGE_SPEECH_MAX_SOURCE_CHARS } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vite-plus/test";

import {
  getElevenLabsTtsCharacterLimit,
  isMessageSpeechCacheReusable,
  isMessageSpeechSourceEligible,
  makeMessageSpeechLockCoordinator,
} from "./MessageSpeech.ts";

describe("message speech locking", () => {
  effectIt.effect("serializes the same message and evicts locks after success or failure", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeMessageSpeechLockCoordinator();
      const active = yield* Ref.make(0);
      const maxActive = yield* Ref.make(0);
      const run = coordinator.withMessageLock(
        "message",
        Effect.gen(function* () {
          const count = yield* Ref.updateAndGet(active, (value) => value + 1);
          yield* Ref.update(maxActive, (value) => Math.max(value, count));
          yield* Effect.sleep("10 millis");
          yield* Ref.update(active, (value) => value - 1);
        }),
      );

      yield* Effect.all([run, run], { concurrency: "unbounded" });
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
