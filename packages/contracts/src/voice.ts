import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VOICE_TRANSCRIPTION_MAX_DURATION_MS = 3 * 60 * 1_000;
export const VOICE_TRANSCRIPTION_MIN_DURATION_MS = 100;
export const VOICE_TRANSCRIPTION_MAX_BYTES = 6 * 1_024 * 1_024;
export const VOICE_TRANSCRIPTION_MAX_DATA_URL_CHARS =
  Math.ceil(VOICE_TRANSCRIPTION_MAX_BYTES / 3) * 4 + 128;

export const VoiceAudioMimeType = Schema.Literals([
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav",
]);
export type VoiceAudioMimeType = typeof VoiceAudioMimeType.Type;

export const VoiceTranscriptionRequest = Schema.Struct({
  mimeType: VoiceAudioMimeType,
  dataUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(VOICE_TRANSCRIPTION_MAX_DATA_URL_CHARS)),
  durationMs: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(VOICE_TRANSCRIPTION_MIN_DURATION_MS),
  ).check(Schema.isLessThanOrEqualTo(VOICE_TRANSCRIPTION_MAX_DURATION_MS)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(VOICE_TRANSCRIPTION_MAX_BYTES)),
});
export type VoiceTranscriptionRequest = typeof VoiceTranscriptionRequest.Type;

export const VoiceTranscriptionResult = Schema.Struct({
  text: TrimmedNonEmptyString,
  languageCode: Schema.optionalKey(TrimmedNonEmptyString),
});
export type VoiceTranscriptionResult = typeof VoiceTranscriptionResult.Type;

/**
 * Which vendor synthesizes speech. ElevenLabs is keyed by the server's
 * `ELEVENLABS_API_KEY`; OpenRouter by an inference key kept in the server's
 * secret store, and covers every model its speech endpoint lists.
 */
export const TtsProvider = Schema.Literals(["elevenlabs", "openrouter"]);
export type TtsProvider = typeof TtsProvider.Type;

export const TTS_PROVIDER_LABELS: Record<TtsProvider, string> = {
  elevenlabs: "ElevenLabs",
  openrouter: "OpenRouter",
};

/**
 * A fully resolved synthesis target, as the server uses it and as the test
 * dialog submits it. Settings hold a partial form of this whose empty fields
 * fall back to the server's defaults (see `TtsProfileSettings`).
 */
export const TtsProfile = Schema.Struct({
  provider: TtsProvider,
  modelId: TrimmedNonEmptyString,
  voiceId: TrimmedNonEmptyString,
  /** Style direction for models that take one; ignored elsewhere. */
  instructions: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TtsProfile = typeof TtsProfile.Type;

export const TtsCatalogVoice = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** Free-form hint such as "pl · male" for ElevenLabs library voices. */
  detail: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TtsCatalogVoice = typeof TtsCatalogVoice.Type;

export const TtsCatalogModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /**
   * Voices this model accepts. Null means any voice in the catalog's shared
   * `voices` list (ElevenLabs voices are account-wide, not per model).
   */
  voices: Schema.NullOr(Schema.Array(TtsCatalogVoice)),
  /** Longest text one request accepts, when the vendor states it. */
  maxInputChars: Schema.NullOr(NonNegativeInt),
  /** List price per million input characters, when derivable. */
  priceUsdPerMillionChars: Schema.NullOr(Schema.Number.check(Schema.isFinite())),
  /** Additional per-million output audio token price (token-priced models). */
  priceUsdPerMillionAudioTokens: Schema.NullOr(Schema.Number.check(Schema.isFinite())),
  supportsInstructions: Schema.Boolean,
});
export type TtsCatalogModel = typeof TtsCatalogModel.Type;

export const TtsCatalogInput = Schema.Struct({
  provider: TtsProvider,
});
export type TtsCatalogInput = typeof TtsCatalogInput.Type;

export const TtsCatalogResult = Schema.Struct({
  provider: TtsProvider,
  configured: Schema.Boolean,
  models: Schema.Array(TtsCatalogModel),
  /** Account-wide voices for providers whose models set `voices: null`. */
  voices: Schema.Array(TtsCatalogVoice),
  /** Why the catalog is empty or stale; safe to render verbatim. */
  error: Schema.optional(Schema.String),
});
export type TtsCatalogResult = typeof TtsCatalogResult.Type;

export const TtsStatusInput = Schema.Struct({});
export type TtsStatusInput = typeof TtsStatusInput.Type;

/**
 * What a profile with blank model and voice resolves to on this server: its
 * `*_TTS_MODEL` / `*_TTS_VOICE_ID` environment overrides, else the built-in
 * defaults. Clients display and test against these instead of guessing.
 */
export const TtsProviderDefaults = Schema.Struct({
  modelId: TrimmedNonEmptyString,
  voiceId: TrimmedNonEmptyString,
});
export type TtsProviderDefaults = typeof TtsProviderDefaults.Type;

export const TtsProviderStatus = Schema.Struct({
  configured: Schema.Boolean,
  defaults: TtsProviderDefaults,
  /** Why a key could not be read; safe to render verbatim. */
  error: Schema.optional(Schema.String),
});
export type TtsProviderStatus = typeof TtsProviderStatus.Type;

export const TtsStatusResult = Schema.Struct({
  elevenlabs: TtsProviderStatus,
  openrouter: TtsProviderStatus,
});
export type TtsStatusResult = typeof TtsStatusResult.Type;

export const TtsConfigureOpenRouterInput = Schema.Struct({
  /** An OpenRouter inference key; empty removes the stored key. */
  apiKey: Schema.String,
});
export type TtsConfigureOpenRouterInput = typeof TtsConfigureOpenRouterInput.Type;

export const TtsConfigureOpenRouterResult = Schema.Struct({
  configured: Schema.Boolean,
});
export type TtsConfigureOpenRouterResult = typeof TtsConfigureOpenRouterResult.Type;

export const TTS_TEST_MAX_TEXT_CHARS = 2_000;

export const TtsTestInput = Schema.Struct({
  profile: TtsProfile,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(TTS_TEST_MAX_TEXT_CHARS)),
});
export type TtsTestInput = typeof TtsTestInput.Type;

/**
 * Container a synthesized recording is stored and served in. ElevenLabs and
 * most OpenRouter models return MP3; OpenRouter's Gemini route only serves
 * raw PCM, which the server wraps as WAV so every client plays it natively.
 */
export const SpeechAudioMimeType = Schema.Literals(["audio/mpeg", "audio/wav"]);
export type SpeechAudioMimeType = typeof SpeechAudioMimeType.Type;

/**
 * Extension a recording is stored under and named with in its asset URL.
 * Native players pick the decoder from this suffix, so clients must derive
 * it from the MIME type rather than assume `.mp3`.
 */
export const speechAudioFileExtension = (mimeType: SpeechAudioMimeType): ".mp3" | ".wav" =>
  mimeType === "audio/wav" ? ".wav" : ".mp3";

export const TtsSynthesisCost = Schema.Struct({
  /** Billed amount in USD when the vendor reports it (OpenRouter). */
  usd: Schema.NullOr(Schema.Number.check(Schema.isFinite())),
  /** Characters the vendor billed for (ElevenLabs `character-cost`). */
  billedCharacters: Schema.NullOr(NonNegativeInt),
});
export type TtsSynthesisCost = typeof TtsSynthesisCost.Type;

export const TtsTestResult = Schema.Struct({
  mimeType: SpeechAudioMimeType,
  audioBase64: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
  characterCount: NonNegativeInt,
  cost: TtsSynthesisCost,
});
export type TtsTestResult = typeof TtsTestResult.Type;

export const TtsRpcErrorReason = Schema.Literals([
  "unavailable",
  "invalid_profile",
  "provider_failed",
  "provider_quota_exceeded",
  "text_too_long",
]);
export type TtsRpcErrorReason = typeof TtsRpcErrorReason.Type;

export class TtsRpcError extends Schema.TaggedError<TtsRpcError>()("TtsRpcError", {
  reason: TtsRpcErrorReason,
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const MESSAGE_SPEECH_MAX_SOURCE_CHARS = 40_000;
export const MESSAGE_SPEECH_MAX_SCRIPT_CHARS = 40_000;
export const MESSAGE_SUMMARY_MAX_SOURCE_CHARS = 120_000;
export const MESSAGE_SUMMARY_MAX_TEXT_CHARS = 12_000;

/**
 * Who produced a message's speech artifact. "user" is the on-demand listening
 * version a client requested; "agent" is a recording the agent staged itself
 * through the voice_reply MCP tool. Agent recordings are presented as the
 * primary form of the message; user ones stay an opt-in secondary artifact.
 */
export const MessageSpeechOrigin = Schema.Literals(["user", "agent"]);
export type MessageSpeechOrigin = typeof MessageSpeechOrigin.Type;

export const MessageSpeechFailureReason = Schema.Literals([
  "unavailable",
  "message_unavailable",
  "source_too_long",
  "script_failed",
  "provider_failed",
  // The speech vendor refused the request because the account's character
  // quota is used up; retrying cannot help until credits are added or reset.
  "provider_quota_exceeded",
  "storage_failed",
]);
export type MessageSpeechFailureReason = typeof MessageSpeechFailureReason.Type;

export const MessageSpeechSynthesisRequest = Schema.Struct({
  messageId: MessageId,
});
export type MessageSpeechSynthesisRequest = typeof MessageSpeechSynthesisRequest.Type;

export const MessageSpeechSynthesisResult = Schema.Struct({
  messageId: MessageId,
  speechId: TrimmedNonEmptyString,
  transcript: TrimmedNonEmptyString.check(Schema.isMaxLength(MESSAGE_SPEECH_MAX_SCRIPT_CHARS)),
  mimeType: SpeechAudioMimeType,
  sizeBytes: NonNegativeInt,
  // Optional so payloads persisted before agent voice replies still decode;
  // absent means "user".
  origin: Schema.optional(MessageSpeechOrigin),
  createdAt: IsoDateTime,
});
export type MessageSpeechSynthesisResult = typeof MessageSpeechSynthesisResult.Type;

export const AGENT_VOICE_REPLY_MAX_SCRIPT_CHARS = 10_000;

/**
 * Speech metadata carried on an assistant-message completion. The audio bytes
 * live in the server attachments directory under `<speechId>.mp3` or `.wav`
 * by MIME type (written
 * before the command is dispatched, mirroring how user image attachments are
 * persisted by the normalizer); the event stream only ever sees metadata.
 */
const MessageSpeechAttachmentBase = {
  speechId: TrimmedNonEmptyString,
  transcript: TrimmedNonEmptyString.check(Schema.isMaxLength(MESSAGE_SPEECH_MAX_SCRIPT_CHARS)),
  mimeType: SpeechAudioMimeType,
  sizeBytes: NonNegativeInt,
  sourceTextHash: TrimmedNonEmptyString,
  voiceId: TrimmedNonEmptyString,
  ttsModel: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
} as const;

export const MessageSpeechAttachment = Schema.Union([
  Schema.Struct({
    ...MessageSpeechAttachmentBase,
    origin: Schema.Literal("user"),
    scriptRecipeHash: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...MessageSpeechAttachmentBase,
    origin: Schema.Literal("agent"),
    // Agent voice replies do not use the listening-version script recipe.
    // Optional keeps their existing persisted events replayable.
    scriptRecipeHash: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type MessageSpeechAttachment = typeof MessageSpeechAttachment.Type;

export const AgentVoiceReplyInput = Schema.Struct({
  script: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_VOICE_REPLY_MAX_SCRIPT_CHARS)),
});
export type AgentVoiceReplyInput = typeof AgentVoiceReplyInput.Type;

export const AgentVoiceReplyResult = Schema.Struct({
  status: Schema.Literal("staged"),
  transcriptChars: NonNegativeInt,
  audioSizeBytes: NonNegativeInt,
});
export type AgentVoiceReplyResult = typeof AgentVoiceReplyResult.Type;

export class AgentVoiceReplyError extends Schema.TaggedError<AgentVoiceReplyError>()(
  "AgentVoiceReplyError",
  {
    // turn_unavailable: the thread has no identifiable active turn, or the
    // active turn changed while the recording was being synthesized (the turn
    // was steered or aborted), so the recording has no turn to attach to.
    reason: Schema.Literals([
      "unavailable",
      "empty_script",
      "script_too_long",
      "turn_unavailable",
      "provider_failed",
      "provider_quota_exceeded",
      "storage_failed",
    ]),
  },
) {
  /** The tool error text the agent sees, so it can tell the user what went wrong. */
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Voice replies are not configured on this server.";
      case "empty_script":
        return "The script is empty.";
      case "script_too_long":
        return "The script is too long for one recording. Shorten it.";
      case "turn_unavailable":
        return "There is no active turn to attach the recording to.";
      case "provider_failed":
        return "The speech provider could not synthesize the recording. Reply in text instead.";
      case "provider_quota_exceeded":
        return "The speech provider refused the request: the account's quota or credits are used up. Do not retry; tell the user in your written reply.";
      case "storage_failed":
        return "The recording could not be stored on the server.";
    }
  }
}

export const MessageSummaryRequest = Schema.Struct({
  messageId: MessageId,
});
export type MessageSummaryRequest = typeof MessageSummaryRequest.Type;

export const MessageSummaryResult = Schema.Struct({
  messageId: MessageId,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(MESSAGE_SUMMARY_MAX_TEXT_CHARS)),
  createdAt: IsoDateTime,
});
export type MessageSummaryResult = typeof MessageSummaryResult.Type;
