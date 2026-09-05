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
  mimeType: Schema.Literal("audio/mpeg"),
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
 * live in the server attachments directory under `<speechId>.mp3` (written
 * before the command is dispatched, mirroring how user image attachments are
 * persisted by the normalizer); the event stream only ever sees metadata.
 */
const MessageSpeechAttachmentBase = {
  speechId: TrimmedNonEmptyString,
  transcript: TrimmedNonEmptyString.check(Schema.isMaxLength(MESSAGE_SPEECH_MAX_SCRIPT_CHARS)),
  mimeType: Schema.Literal("audio/mpeg"),
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

export class AgentVoiceReplyError extends Schema.TaggedErrorClass<AgentVoiceReplyError>()(
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
        return "ElevenLabs could not synthesize the recording. Reply in text instead.";
      case "provider_quota_exceeded":
        return "ElevenLabs refused the request: the account's character quota is used up. Do not retry; tell the user in your written reply.";
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
