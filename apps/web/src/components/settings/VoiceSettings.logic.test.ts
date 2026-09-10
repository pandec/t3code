import { describe, expect, it } from "vite-plus/test";

import {
  describeCatalogModel,
  describeTestCost,
  formatSmallUsd,
  resolveDisplayedTtsProfile,
  voicesForModel,
} from "./VoiceSettings.logic";

const gemini = {
  id: "google/gemini-3.1-flash-tts-preview",
  name: "Gemini 3.1 Flash TTS",
  voices: [{ id: "Kore", name: "Kore" }],
  maxInputChars: null,
  priceUsdPerMillionChars: 1,
  priceUsdPerMillionAudioTokens: 20,
  supportsInstructions: true,
};

const elevenFlash = {
  id: "eleven_flash_v2_5",
  name: "Eleven Flash v2.5",
  voices: null,
  maxInputChars: 40_000,
  priceUsdPerMillionChars: 50,
  priceUsdPerMillionAudioTokens: null,
  supportsInstructions: false,
};

describe("resolveDisplayedTtsProfile", () => {
  it("fills empty fields with the provider defaults and drops blank instructions", () => {
    expect(
      resolveDisplayedTtsProfile({
        provider: "openrouter",
        modelId: "",
        voiceId: " ",
        instructions: "  ",
      }),
    ).toEqual({
      provider: "openrouter",
      modelId: "google/gemini-3.1-flash-tts-preview",
      voiceId: "Kore",
    });
    expect(
      resolveDisplayedTtsProfile({
        provider: "elevenlabs",
        modelId: "eleven_v3",
        voiceId: "abc",
        instructions: "warm",
      }),
    ).toEqual({
      provider: "elevenlabs",
      modelId: "eleven_v3",
      voiceId: "abc",
      instructions: "warm",
    });
  });
});

describe("voicesForModel", () => {
  it("prefers the model's own voices and falls back to the shared catalog", () => {
    const shared = [{ id: "v", name: "Shared" }];
    const catalog = {
      provider: "elevenlabs" as const,
      configured: true,
      models: [],
      voices: shared,
    };
    expect(voicesForModel(catalog, gemini)).toEqual(gemini.voices);
    expect(voicesForModel(catalog, elevenFlash)).toEqual(shared);
    expect(voicesForModel(null, null)).toEqual([]);
  });
});

describe("describeCatalogModel", () => {
  it("shows the price and limit that are known", () => {
    expect(describeCatalogModel(gemini)).toBe("$1 / 1M chars + $20 / 1M audio tokens");
    expect(describeCatalogModel(elevenFlash)).toBe(
      "$50 / 1M chars · up to 40,000 chars per request",
    );
    expect(describeCatalogModel({ ...gemini, priceUsdPerMillionChars: null })).toBeNull();
  });
});

describe("describeTestCost", () => {
  it("prefers the billed dollar amount, then billed characters at list price", () => {
    expect(
      describeTestCost({
        cost: { usd: 0.00042, billedCharacters: null },
        characterCount: 210,
        model: gemini,
      }),
    ).toBe("210 chars · $0.00042");
    expect(
      describeTestCost({
        cost: { usd: null, billedCharacters: 105 },
        characterCount: 210,
        model: elevenFlash,
      }),
    ).toBe("105 billed chars · $0.00525 at list price");
    expect(
      describeTestCost({
        cost: { usd: null, billedCharacters: null },
        characterCount: 210,
        model: null,
      }),
    ).toBe("210 chars");
  });
});

describe("formatSmallUsd", () => {
  it("keeps sub-cent amounts readable", () => {
    expect(formatSmallUsd(0)).toBe("$0");
    expect(formatSmallUsd(1.5)).toBe("$1.50");
    expect(formatSmallUsd(0.0325)).toBe("$0.033");
    expect(formatSmallUsd(0.00042)).toBe("$0.00042");
  });
});
