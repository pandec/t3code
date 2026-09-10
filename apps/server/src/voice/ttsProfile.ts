import type {
  TtsProfile,
  TtsProfileSettings,
  TtsProvider,
  VoiceSettings,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * Built-in synthesis defaults, one per provider. Selecting a provider
 * without naming a model or voice lands here. OpenRouter's default is Gemini
 * 3.1 Flash TTS: it scores above every ElevenLabs model short of v3 in blind
 * listening tests, supports 70+ languages, and costs a third as much.
 */
export const DEFAULT_TTS_PROVIDER: TtsProvider = "openrouter";
export const DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";
export const DEFAULT_ELEVENLABS_TTS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
export const DEFAULT_OPENROUTER_TTS_MODEL = "google/gemini-3.1-flash-tts-preview";
export const DEFAULT_OPENROUTER_TTS_VOICE_ID = "Kore";

export const DEFAULT_TTS_MODEL_BY_PROVIDER: Record<TtsProvider, string> = {
  elevenlabs: DEFAULT_ELEVENLABS_TTS_MODEL,
  openrouter: DEFAULT_OPENROUTER_TTS_MODEL,
};
export const DEFAULT_TTS_VOICE_BY_PROVIDER: Record<TtsProvider, string> = {
  elevenlabs: DEFAULT_ELEVENLABS_TTS_VOICE_ID,
  openrouter: DEFAULT_OPENROUTER_TTS_VOICE_ID,
};

/**
 * Environment fallbacks, read once at layer build. `ELEVENLABS_TTS_*` are the
 * pre-OpenRouter names and keep working; the OpenRouter pair mirrors them.
 */
export interface TtsEnvironmentDefaults {
  readonly elevenlabs: { readonly modelId: string; readonly voiceId: string };
  readonly openrouter: { readonly modelId: string; readonly voiceId: string };
}

export const readTtsEnvironmentDefaults: Effect.Effect<TtsEnvironmentDefaults> = Effect.gen(
  function* () {
    const read = (name: string, fallback: string) =>
      Config.string(name).pipe(
        Config.withDefault(fallback),
        Effect.map((value) => value.trim() || fallback),
      );
    return {
      elevenlabs: {
        modelId: yield* read("ELEVENLABS_TTS_MODEL", DEFAULT_ELEVENLABS_TTS_MODEL),
        voiceId: yield* read("ELEVENLABS_TTS_VOICE_ID", DEFAULT_ELEVENLABS_TTS_VOICE_ID),
      },
      openrouter: {
        modelId: yield* read("OPENROUTER_TTS_MODEL", DEFAULT_OPENROUTER_TTS_MODEL),
        voiceId: yield* read("OPENROUTER_TTS_VOICE_ID", DEFAULT_OPENROUTER_TTS_VOICE_ID),
      },
    };
  },
).pipe(Effect.orDie);

/**
 * Resolution order for one profile field: the setting wins, then the
 * environment variable, then the built-in default. Whitespace-only values
 * count as unset so an untouched install keeps its previous behaviour.
 */
export function resolveMessageSpeechVoiceSetting(
  settingValue: string | null | undefined,
  environmentValue: string | null | undefined,
  defaultValue: string,
): string {
  const setting = settingValue?.trim();
  if (setting && setting.length > 0) {
    return setting;
  }
  const environment = environmentValue?.trim();
  return environment && environment.length > 0 ? environment : defaultValue;
}

export function resolveTtsProfile(
  settings: TtsProfileSettings,
  environment: TtsEnvironmentDefaults,
): TtsProfile {
  const provider = settings.provider;
  const instructions = settings.instructions.trim();
  return {
    provider,
    modelId: resolveMessageSpeechVoiceSetting(
      settings.modelId,
      environment[provider].modelId,
      DEFAULT_TTS_MODEL_BY_PROVIDER[provider],
    ),
    voiceId: resolveMessageSpeechVoiceSetting(
      settings.voiceId,
      environment[provider].voiceId,
      DEFAULT_TTS_VOICE_BY_PROVIDER[provider],
    ),
    ...(instructions.length > 0 ? { instructions } : {}),
  };
}

/** Profile for on-demand message listening. */
export const resolveListeningTtsProfile = (
  voice: VoiceSettings,
  environment: TtsEnvironmentDefaults,
): TtsProfile => resolveTtsProfile(voice.tts, environment);

/** Profile for agent voice replies: the override when set, else the default. */
export const resolveAgentReplyTtsProfile = (
  voice: VoiceSettings,
  environment: TtsEnvironmentDefaults,
): TtsProfile => resolveTtsProfile(voice.agentReplyTts ?? voice.tts, environment);

/**
 * Longest text one request may carry. ElevenLabs publishes per-model limits;
 * OpenRouter models are token-bounded and vary, so the smallest documented
 * one (Gemini's 8k input tokens, roughly 25k characters) is the ceiling.
 */
export function getTtsCharacterLimit(profile: Pick<TtsProfile, "provider" | "modelId">): number {
  if (profile.provider === "openrouter") {
    return 20_000;
  }
  switch (profile.modelId) {
    case "eleven_flash_v2_5":
    case "eleven_turbo_v2_5":
      return 40_000;
    case "eleven_flash_v2":
    case "eleven_turbo_v2":
      return 30_000;
    case "eleven_multilingual_v2":
    case "eleven_multilingual_v1":
      return 10_000;
    case "eleven_v3":
      return 5_000;
    default:
      return 5_000;
  }
}
