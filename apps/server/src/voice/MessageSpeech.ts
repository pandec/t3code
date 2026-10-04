// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  MESSAGE_SPEECH_MAX_SOURCE_CHARS,
  MessageSpeechFailureReason,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { makeMessageArtifactLockCoordinator } from "../messageArtifacts/lock.ts";
import { isSpeechAudioMimeType } from "./ttsTypes.ts";

export { makeMessageArtifactLockCoordinator as makeMessageSpeechLockCoordinator };
export {
  DEFAULT_ELEVENLABS_TTS_MODEL,
  DEFAULT_ELEVENLABS_TTS_VOICE_ID,
  getTtsCharacterLimit,
  resolveMessageSpeechVoiceSetting,
} from "./ttsProfile.ts";

const SPEECH_SCRIPT_RECIPE_VERSION = 2;

export function messageSpeechRecipeHash(input: {
  readonly modelSelection: ModelSelection;
  readonly instructions?: string | undefined;
}): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        version: SPEECH_SCRIPT_RECIPE_VERSION,
        modelSelection: input.modelSelection,
        instructions: input.instructions?.trim() || null,
      }),
      "utf8",
    )
    .digest("hex");
}

interface MessageSpeechCacheRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly speechId: string;
  readonly transcript: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly durationMs: number | null;
  readonly sourceTextHash: string;
  readonly scriptRecipeHash: string;
  readonly voiceId: string;
  readonly ttsModel: string;
  readonly origin: string;
  readonly createdAt: string;
}

export type MessageSpeechSourceFailureReason = Extract<
  MessageSpeechFailureReason,
  "message_unavailable" | "source_too_long"
>;

export function getMessageSpeechSourceFailureReason(input: {
  readonly role: string;
  readonly isStreaming: boolean;
  readonly text: string;
  readonly maxSourceChars?: number;
}): MessageSpeechSourceFailureReason | null {
  const text = input.text.trim();
  if (input.role !== "assistant" || input.isStreaming || text.length === 0) {
    return "message_unavailable";
  }
  return text.length > (input.maxSourceChars ?? MESSAGE_SPEECH_MAX_SOURCE_CHARS)
    ? "source_too_long"
    : null;
}

export function isMessageSpeechSourceEligible(input: {
  readonly role: string;
  readonly isStreaming: boolean;
  readonly text: string;
  readonly maxSourceChars?: number;
}): boolean {
  return getMessageSpeechSourceFailureReason(input) === null;
}

export function isMessageSpeechCacheReusable(input: {
  readonly cache: Pick<
    MessageSpeechCacheRow,
    "sourceTextHash" | "scriptRecipeHash" | "voiceId" | "ttsModel" | "mimeType"
  >;
  readonly sourceTextHash: string;
  readonly scriptRecipeHash: string;
  readonly voiceId: string;
  readonly ttsModel: string;
}): boolean {
  return (
    input.cache.sourceTextHash === input.sourceTextHash &&
    input.cache.scriptRecipeHash === input.scriptRecipeHash &&
    input.cache.voiceId === input.voiceId &&
    input.cache.ttsModel === input.ttsModel &&
    isSpeechAudioMimeType(input.cache.mimeType)
  );
}

export class MessageSpeechError extends Schema.TaggedError<MessageSpeechError>()(
  "MessageSpeechError",
  {
    reason: MessageSpeechFailureReason,
  },
) {}
