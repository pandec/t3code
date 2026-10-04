import type { MessageInputOrigin } from "@t3tools/contracts";

const VOICE_TRANSCRIPTION_NOTICE =
  "<voice_transcription_notice>This message was transcribed from speech and may contain recognition errors. If any wording, names, identifiers, or code seem implausible, ask the user a brief follow-up question instead of guessing.</voice_transcription_notice>";

/**
 * Provider-bound text for a user message. Dictated messages get a caution
 * notice; the stored and displayed message keeps only the user's words.
 * Empty (attachment-only) messages and slash commands are left untouched.
 */
export function withInputOriginNotice(
  text: string,
  inputOrigin: MessageInputOrigin | undefined,
): string {
  if (inputOrigin !== "voice-transcription") return text;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.startsWith("/")) return text;
  return `${text.trimEnd()}\n\n${VOICE_TRANSCRIPTION_NOTICE}`;
}
