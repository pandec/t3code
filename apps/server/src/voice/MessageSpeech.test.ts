import { MESSAGE_SPEECH_MAX_SOURCE_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getElevenLabsTtsCharacterLimit,
  isMessageSpeechCacheReusable,
  isMessageSpeechSourceEligible,
} from "./MessageSpeech.ts";

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
