// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AGENT_VOICE_REPLY_MAX_SCRIPT_CHARS,
  AgentVoiceReplyError,
  type MessageSpeechAttachment,
  type ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient } from "effect/unstable/http";

import { createAttachmentId } from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SPEECH_MIME_TYPE, synthesizeElevenLabsSpeech } from "./elevenLabsTts.ts";
import {
  DEFAULT_ELEVENLABS_TTS_MODEL,
  DEFAULT_ELEVENLABS_TTS_VOICE_ID,
  getElevenLabsTtsCharacterLimit,
  resolveMessageSpeechVoiceSetting,
} from "./MessageSpeech.ts";

/**
 * Agent-staged voice replies. The `voice_reply` MCP tool synthesizes a
 * recording mid-turn and parks it here; provider-runtime ingestion collects it
 * when the turn completes and attaches it to the turn's final assistant
 * message. One staged reply per thread — a second call replaces the first.
 *
 * The MP3 is written to the attachments directory at stage time so the later
 * attach command can stay metadata-only, mirroring how user image attachments
 * are persisted by the normalizer before their event is recorded.
 */
export interface AgentVoiceReplyShape {
  readonly available: boolean;
  readonly stage: (input: {
    readonly threadId: ThreadId;
    readonly script: string;
  }) => Effect.Effect<MessageSpeechAttachment, AgentVoiceReplyError>;
  /** Removes and returns the staged reply without touching its audio file. */
  readonly takeStaged: (threadId: ThreadId) => Effect.Effect<MessageSpeechAttachment | undefined>;
  /** Removes the staged reply and deletes its audio file, if any. */
  readonly discardStaged: (threadId: ThreadId) => Effect.Effect<void>;
  /** Deletes the audio file behind a reply that will never be attached. */
  readonly removeStagedAudio: (staged: MessageSpeechAttachment) => Effect.Effect<void>;
}

export class AgentVoiceReply extends Context.Service<AgentVoiceReply, AgentVoiceReplyShape>()(
  "t3/voice/AgentVoiceReply",
) {}

/** Inert instance for tests and harnesses that do not exercise voice replies. */
export const layerNoop = Layer.succeed(AgentVoiceReply, {
  available: false,
  stage: () => Effect.fail(new AgentVoiceReplyError({ reason: "unavailable" })),
  takeStaged: () => Effect.succeed(undefined),
  discardStaged: () => Effect.void,
  removeStagedAudio: () => Effect.void,
});

export const layer = Layer.effect(
  AgentVoiceReply,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("ELEVENLABS_API_KEY").pipe(Config.option);
    const envTtsModel = yield* Config.string("ELEVENLABS_TTS_MODEL").pipe(
      Config.withDefault(DEFAULT_ELEVENLABS_TTS_MODEL),
    );
    const envVoiceId = yield* Config.string("ELEVENLABS_TTS_VOICE_ID").pipe(
      Config.withDefault(DEFAULT_ELEVENLABS_TTS_VOICE_ID),
    );
    const available = Option.isSome(apiKey) && Redacted.value(apiKey.value).trim().length > 0;
    const httpClient = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const staged = yield* SynchronizedRef.make<ReadonlyMap<ThreadId, MessageSpeechAttachment>>(
      new Map(),
    );

    const resolveSpeechPath = (speechId: string) =>
      resolveAttachmentRelativePath({
        attachmentsDir: serverConfig.attachmentsDir,
        relativePath: `${speechId}.mp3`,
      });

    const removeAudioFile = (speechId: string) => {
      const path = resolveSpeechPath(speechId);
      return path ? fileSystem.remove(path, { force: true }).pipe(Effect.ignore) : Effect.void;
    };

    const stage: AgentVoiceReplyShape["stage"] = Effect.fn("AgentVoiceReply.stage")(
      function* (input) {
        if (!available || Option.isNone(apiKey)) {
          return yield* new AgentVoiceReplyError({ reason: "unavailable" });
        }

        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(() => new AgentVoiceReplyError({ reason: "storage_failed" })),
        );
        const ttsModel = resolveMessageSpeechVoiceSetting(
          settings.voice.ttsModelId,
          envTtsModel,
          DEFAULT_ELEVENLABS_TTS_MODEL,
        );
        const voiceId = resolveMessageSpeechVoiceSetting(
          settings.voice.ttsVoiceId,
          envVoiceId,
          DEFAULT_ELEVENLABS_TTS_VOICE_ID,
        );

        const script = input.script.trim();
        const characterLimit = Math.min(
          AGENT_VOICE_REPLY_MAX_SCRIPT_CHARS,
          getElevenLabsTtsCharacterLimit(ttsModel),
        );
        if (script.length === 0 || script.length > characterLimit) {
          return yield* new AgentVoiceReplyError({ reason: "script_too_long" });
        }

        const audioBytes = yield* synthesizeElevenLabsSpeech({
          httpClient,
          apiKey: apiKey.value,
          voiceId,
          ttsModel,
          text: script,
        }).pipe(Effect.mapError(() => new AgentVoiceReplyError({ reason: "provider_failed" })));

        const speechId = createAttachmentId(input.threadId);
        const speechPath = speechId ? resolveSpeechPath(speechId) : null;
        if (!speechId || !speechPath) {
          return yield* new AgentVoiceReplyError({ reason: "storage_failed" });
        }
        yield* fileSystem.makeDirectory(serverConfig.attachmentsDir, { recursive: true }).pipe(
          Effect.andThen(fileSystem.writeFile(speechPath, audioBytes)),
          Effect.mapError(() => new AgentVoiceReplyError({ reason: "storage_failed" })),
        );

        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const attachment: MessageSpeechAttachment = {
          speechId,
          transcript: script as MessageSpeechAttachment["transcript"],
          mimeType: SPEECH_MIME_TYPE,
          sizeBytes: audioBytes.byteLength as MessageSpeechAttachment["sizeBytes"],
          sourceTextHash: NodeCrypto.createHash("sha256")
            .update(script, "utf8")
            .digest("hex") as MessageSpeechAttachment["sourceTextHash"],
          voiceId: voiceId as MessageSpeechAttachment["voiceId"],
          ttsModel: ttsModel as MessageSpeechAttachment["ttsModel"],
          origin: "agent",
          createdAt: createdAt as MessageSpeechAttachment["createdAt"],
        };

        const replaced = yield* SynchronizedRef.modify(staged, (entries) => {
          const previous = entries.get(input.threadId);
          const next = new Map(entries);
          next.set(input.threadId, attachment);
          return [previous, next] as const;
        });
        if (replaced) {
          yield* removeAudioFile(replaced.speechId);
        }
        return attachment;
      },
    );

    const takeStaged: AgentVoiceReplyShape["takeStaged"] = (threadId) =>
      SynchronizedRef.modify(staged, (entries) => {
        const current = entries.get(threadId);
        if (!current) return [undefined, entries] as const;
        const next = new Map(entries);
        next.delete(threadId);
        return [current, next] as const;
      });

    return AgentVoiceReply.of({
      available,
      stage,
      takeStaged,
      discardStaged: (threadId) =>
        takeStaged(threadId).pipe(
          Effect.flatMap((entry) => (entry ? removeAudioFile(entry.speechId) : Effect.void)),
        ),
      removeStagedAudio: (entry) => removeAudioFile(entry.speechId),
    });
  }),
);
