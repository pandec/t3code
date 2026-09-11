import { SpeechAudioMimeType, type TtsSynthesisCost } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Vendor-neutral synthesis failure shared by the ElevenLabs and OpenRouter
 * clients. `quota_exceeded` means retrying cannot help until the account
 * gets credits; every other reason is a transport, status, or empty-body
 * problem. `detail` is safe to show to the user.
 */
export class TtsError extends Schema.TaggedError<TtsError>()("TtsError", {
  reason: Schema.Literals(["unavailable", "request_failed", "quota_exceeded", "empty_audio"]),
  detail: Schema.String,
}) {}

export interface SynthesizedSpeech {
  readonly bytes: Uint8Array;
  readonly mimeType: SpeechAudioMimeType;
  readonly cost: TtsSynthesisCost;
}

export const isSpeechAudioMimeType = Schema.is(SpeechAudioMimeType);

export const MP3_MIME_TYPE: SpeechAudioMimeType = "audio/mpeg";
export const WAV_MIME_TYPE: SpeechAudioMimeType = "audio/wav";

/** File extension a stored recording gets, keyed by the container it is in. */
export const speechFileExtension = (mimeType: SpeechAudioMimeType): ".mp3" | ".wav" =>
  mimeType === WAV_MIME_TYPE ? ".wav" : ".mp3";

/** The speech failure reason a TTS error maps to, shared by both synthesis paths. */
export const speechFailureReasonFor = (
  error: TtsError,
): "unavailable" | "provider_failed" | "provider_quota_exceeded" =>
  error.reason === "unavailable"
    ? "unavailable"
    : error.reason === "quota_exceeded"
      ? "provider_quota_exceeded"
      : "provider_failed";
