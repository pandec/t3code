import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VOICE_TRANSCRIPTION_MAX_DURATION_MS = 3 * 60 * 1_000;
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
  durationMs: NonNegativeInt.check(Schema.isLessThanOrEqualTo(VOICE_TRANSCRIPTION_MAX_DURATION_MS)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(VOICE_TRANSCRIPTION_MAX_BYTES)),
});
export type VoiceTranscriptionRequest = typeof VoiceTranscriptionRequest.Type;

export const VoiceTranscriptionResult = Schema.Struct({
  text: TrimmedNonEmptyString,
  languageCode: Schema.optionalKey(TrimmedNonEmptyString),
});
export type VoiceTranscriptionResult = typeof VoiceTranscriptionResult.Type;
