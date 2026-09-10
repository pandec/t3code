import type {
  TtsCatalogModel,
  TtsCatalogResult,
  TtsCatalogVoice,
  TtsProfile,
  TtsProfileSettings,
  TtsProvider,
  TtsSynthesisCost,
} from "@t3tools/contracts";

/**
 * Mirrors the server's built-in defaults (`DEFAULT_TTS_*` in
 * `apps/server/src/voice/ttsProfile.ts`). Duplicated for display only: the
 * client sends "" to mean "leave it to the server". Keep both in sync.
 */
export const DEFAULT_TTS_MODEL_BY_PROVIDER: Record<TtsProvider, string> = {
  elevenlabs: "eleven_flash_v2_5",
  openrouter: "google/gemini-3.1-flash-tts-preview",
};
export const DEFAULT_TTS_VOICE_BY_PROVIDER: Record<TtsProvider, string> = {
  elevenlabs: "JBFqnCBsd6RMkjVDRZzb",
  openrouter: "Kore",
};

export const TTS_TEST_SAMPLE_TEXT =
  "Here's a quick summary. I refactored the settings panel, added a provider dropdown, and wired up the test button. Two tests failed at first because of a stale mock, so I fixed those too. Everything passes now.";

/** The model and voice the server will use for a stored profile. */
export function resolveDisplayedTtsProfile(profile: TtsProfileSettings): TtsProfile {
  const modelId = profile.modelId.trim() || DEFAULT_TTS_MODEL_BY_PROVIDER[profile.provider];
  const voiceId = profile.voiceId.trim() || DEFAULT_TTS_VOICE_BY_PROVIDER[profile.provider];
  const instructions = profile.instructions.trim();
  return {
    provider: profile.provider,
    modelId,
    voiceId,
    ...(instructions.length > 0 ? { instructions } : {}),
  };
}

export function findCatalogModel(
  catalog: TtsCatalogResult | null,
  modelId: string,
): TtsCatalogModel | null {
  return catalog?.models.find((model) => model.id === modelId) ?? null;
}

/** Voices selectable for a model: its own list, else the catalog's shared list. */
export function voicesForModel(
  catalog: TtsCatalogResult | null,
  model: TtsCatalogModel | null,
): ReadonlyArray<TtsCatalogVoice> {
  if (model?.voices !== null && model?.voices !== undefined) return model.voices;
  return catalog?.voices ?? [];
}

export function formatUsdPerMillionChars(price: number | null): string | null {
  if (price === null) return null;
  return `$${price % 1 === 0 ? price.toFixed(0) : price.toFixed(2)} / 1M chars`;
}

/** One line under the model select: price and request limit, when known. */
export function describeCatalogModel(model: TtsCatalogModel | null): string | null {
  if (model === null) return null;
  const parts: string[] = [];
  const price = formatUsdPerMillionChars(model.priceUsdPerMillionChars);
  if (price !== null) {
    parts.push(
      model.priceUsdPerMillionAudioTokens === null
        ? price
        : `${price} + $${model.priceUsdPerMillionAudioTokens} / 1M audio tokens`,
    );
  }
  if (model.maxInputChars !== null) {
    parts.push(`up to ${model.maxInputChars.toLocaleString()} chars per request`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The cost line after a test synthesis. OpenRouter reports the billed dollar
 * amount; ElevenLabs only reports billed characters, which are priced from
 * the catalog when it is loaded.
 */
export function describeTestCost(input: {
  readonly cost: TtsSynthesisCost;
  readonly characterCount: number;
  readonly model: TtsCatalogModel | null;
}): string {
  const chars = `${input.characterCount.toLocaleString()} chars`;
  if (input.cost.usd !== null) {
    return `${chars} · ${formatSmallUsd(input.cost.usd)}`;
  }
  const billed = input.cost.billedCharacters;
  const perMillion = input.model?.priceUsdPerMillionChars ?? null;
  if (billed !== null && perMillion !== null) {
    return `${billed.toLocaleString()} billed chars · ${formatSmallUsd((billed / 1_000_000) * perMillion)} at list price`;
  }
  if (billed !== null) {
    return `${billed.toLocaleString()} billed chars`;
  }
  if (perMillion !== null) {
    return `${chars} · about ${formatSmallUsd((input.characterCount / 1_000_000) * perMillion)} at list price`;
  }
  return chars;
}

/** Sub-cent amounts keep enough digits to be meaningful. */
export function formatSmallUsd(value: number): string {
  if (value === 0) return "$0";
  if (value >= 0.01) return `$${value.toFixed(value >= 1 ? 2 : 3)}`;
  return `$${value.toFixed(5).replace(/0+$/, "")}`;
}
