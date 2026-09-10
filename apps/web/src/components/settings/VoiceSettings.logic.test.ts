import { describe, expect, it, vi } from "vite-plus/test";

import {
  createTtsTestAudioSession,
  describeCatalogModel,
  describeTestCost,
  formatSmallUsd,
  resolveDisplayedTtsProfile,
  voicesForModel,
  voiceIdAfterModelChange,
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
      resolveDisplayedTtsProfile(
        {
          provider: "openrouter",
          modelId: "",
          voiceId: " ",
          instructions: "  ",
        },
        { modelId: "env/model", voiceId: "EnvVoice" },
      ),
    ).toEqual({
      provider: "openrouter",
      modelId: "env/model",
      voiceId: "EnvVoice",
    });
    expect(
      resolveDisplayedTtsProfile(
        {
          provider: "elevenlabs",
          modelId: "eleven_v3",
          voiceId: "abc",
          instructions: "warm",
        },
        { modelId: "env/model", voiceId: "EnvVoice" },
      ),
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

describe("voiceIdAfterModelChange", () => {
  it("retains supported voices and chooses a compatible replacement", () => {
    const openai = { ...gemini, id: "openai/tts", voices: [{ id: "alloy", name: "Alloy" }] };
    const catalog = {
      provider: "openrouter" as const,
      configured: true,
      models: [gemini, openai, elevenFlash],
      voices: [{ id: "shared", name: "Shared" }],
    };
    expect(voiceIdAfterModelChange(catalog, openai.id, "Kore")).toBe("alloy");
    expect(voiceIdAfterModelChange(catalog, openai.id, "alloy")).toBe("alloy");
    expect(voiceIdAfterModelChange(catalog, elevenFlash.id, "shared")).toBe("shared");
    expect(voiceIdAfterModelChange(null, openai.id, "custom")).toBe("custom");
  });
});

describe("test audio lifecycle", () => {
  it("discards late responses and revokes replaced and closed recordings", async () => {
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const session = createTtsTestAudioSession();
    const result = {
      audioBase64: "AQID",
      mimeType: "audio/mpeg" as const,
      sizeBytes: 3,
      characterCount: 1,
      cost: { usd: null, billedCharacters: null },
    };
    try {
      const stale = session.begin();
      session.clear();
      expect(session.accept(stale, result)).toBeNull();
      expect(create).not.toHaveBeenCalled();
      const first = session.begin();
      expect(session.accept(first, result)).toBe("blob:first");
      const second = session.begin();
      expect(session.isCurrent(first)).toBe(false);
      expect(session.accept(first, result)).toBeNull();
      expect(session.accept(second, result)).toBe("blob:second");
      expect(revoke).toHaveBeenCalledWith("blob:first");
      expect(new Uint8Array(await (create.mock.calls[0]![0] as Blob).arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      session.clear();
      expect(revoke).toHaveBeenCalledWith("blob:second");
      expect(session.accept(second, result)).toBeNull();
    } finally {
      session.clear();
      vi.restoreAllMocks();
    }
  });
});
