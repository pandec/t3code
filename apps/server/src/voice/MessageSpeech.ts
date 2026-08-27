// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  MESSAGE_SPEECH_MAX_SOURCE_CHARS,
  MessageSpeechFailureReason,
  type MessageSpeechAttachment,
  type MessageSpeechSynthesisRequest,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpClient } from "effect/unstable/http";

import { createAttachmentId } from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { makeMessageArtifactLockCoordinator } from "../messageArtifacts/lock.ts";
import { SPEECH_MIME_TYPE, synthesizeElevenLabsSpeech } from "./elevenLabsTts.ts";

export { makeMessageArtifactLockCoordinator as makeMessageSpeechLockCoordinator };

export const DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";
export const DEFAULT_ELEVENLABS_TTS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const SPEECH_SCRIPT_RECIPE_VERSION = 2;

interface MessageSpeechCacheRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly speechId: string;
  readonly transcript: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sourceTextHash: string;
  readonly scriptRecipeHash: string;
  readonly voiceId: string;
  readonly ttsModel: string;
  readonly origin: string;
  readonly createdAt: string;
}

interface AssistantMessageRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly role: string;
  readonly text: string;
  readonly isStreaming: number;
}

export function isMessageSpeechSourceEligible(input: {
  readonly role: string;
  readonly isStreaming: boolean;
  readonly text: string;
  readonly maxSourceChars?: number;
}): boolean {
  const text = input.text.trim();
  return (
    input.role === "assistant" &&
    !input.isStreaming &&
    text.length > 0 &&
    text.length <= (input.maxSourceChars ?? MESSAGE_SPEECH_MAX_SOURCE_CHARS)
  );
}

export function getElevenLabsTtsCharacterLimit(model: string): number {
  switch (model) {
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

/**
 * Resolution order for the TTS model and voice: the server setting wins, then
 * the `ELEVENLABS_TTS_*` environment variable, then the built-in default.
 *
 * The setting is read per synthesis, so changing it takes effect on the next
 * playback without restarting the server; an empty (or whitespace-only) value
 * means "unset" and defers to the environment, which is how an untouched
 * install keeps its previous behaviour.
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
    input.cache.mimeType === SPEECH_MIME_TYPE
  );
}

export class MessageSpeechError extends Schema.TaggedErrorClass<MessageSpeechError>()(
  "MessageSpeechError",
  {
    reason: MessageSpeechFailureReason,
  },
) {}

export class MessageSpeech extends Context.Service<
  MessageSpeech,
  {
    readonly available: boolean;
    readonly synthesize: (
      request: MessageSpeechSynthesisRequest,
    ) => Effect.Effect<MessageSpeechAttachment, MessageSpeechError>;
    readonly deleteAttachment: (speechId: string) => Effect.Effect<void, MessageSpeechError>;
  }
>()("t3/voice/MessageSpeech") {}

const storageError = () => new MessageSpeechError({ reason: "storage_failed" });

export const layer = Layer.effect(
  MessageSpeech,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("ELEVENLABS_API_KEY").pipe(Config.option);
    // Environment fallbacks, read once; the per-synthesis server setting takes
    // precedence over them (see resolveMessageSpeechVoiceSetting).
    const envTtsModel = yield* Config.string("ELEVENLABS_TTS_MODEL").pipe(
      Config.withDefault(DEFAULT_ELEVENLABS_TTS_MODEL),
    );
    const envVoiceId = yield* Config.string("ELEVENLABS_TTS_VOICE_ID").pipe(
      Config.withDefault(DEFAULT_ELEVENLABS_TTS_VOICE_ID),
    );
    const available = Option.isSome(apiKey) && Redacted.value(apiKey.value).trim().length > 0;
    const httpClient = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const textGeneration = yield* TextGeneration;
    const synthesisLocks = yield* makeMessageArtifactLockCoordinator();

    const resolveSpeechPath = (speechId: string) =>
      resolveAttachmentRelativePath({
        attachmentsDir: serverConfig.attachmentsDir,
        relativePath: `${speechId}.mp3`,
      });

    const findMessage = (messageId: string) =>
      sql<AssistantMessageRow>`
        SELECT
          messages.message_id AS "messageId",
          messages.thread_id AS "threadId",
          messages.role,
          messages.text,
          messages.is_streaming AS "isStreaming"
        FROM projection_thread_messages AS messages
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = messages.thread_id
          AND threads.deleted_at IS NULL
        WHERE messages.message_id = ${messageId}
        LIMIT 1
      `.pipe(Effect.mapError(storageError));

    const findCachedSpeech = (messageId: string) =>
      sql<MessageSpeechCacheRow>`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          speech_id AS "speechId",
          transcript,
          mime_type AS "mimeType",
          size_bytes AS "sizeBytes",
          source_text_hash AS "sourceTextHash",
          script_recipe_hash AS "scriptRecipeHash",
          voice_id AS "voiceId",
          tts_model AS "ttsModel",
          origin,
          created_at AS "createdAt"
        FROM projection_message_speech
        WHERE message_id = ${messageId}
        LIMIT 1
      `.pipe(Effect.mapError(storageError));

    const toAttachment = (row: MessageSpeechCacheRow): MessageSpeechAttachment => {
      const attachment = {
        speechId: row.speechId,
        transcript: row.transcript as MessageSpeechAttachment["transcript"],
        mimeType: SPEECH_MIME_TYPE,
        sizeBytes: row.sizeBytes as MessageSpeechAttachment["sizeBytes"],
        sourceTextHash: row.sourceTextHash,
        voiceId: row.voiceId,
        ttsModel: row.ttsModel,
        createdAt: row.createdAt as MessageSpeechAttachment["createdAt"],
      };
      return row.origin === "agent"
        ? { ...attachment, origin: "agent", scriptRecipeHash: row.scriptRecipeHash }
        : { ...attachment, origin: "user", scriptRecipeHash: row.scriptRecipeHash };
    };

    const synthesizeUnlocked = Effect.fn("MessageSpeech.synthesizeUnlocked")(function* (
      request: MessageSpeechSynthesisRequest,
    ) {
      if (!available || Option.isNone(apiKey)) {
        return yield* new MessageSpeechError({ reason: "unavailable" });
      }

      const messageRows = yield* findMessage(request.messageId);
      const message = messageRows[0];
      if (!message) {
        return yield* new MessageSpeechError({ reason: "message_unavailable" });
      }

      // Fetched before the eligibility check because the source-length limit
      // depends on the resolved model, which the settings may override.
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => new MessageSpeechError({ reason: "script_failed" })),
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

      const sourceText = message.text.trim();
      const ttsCharacterLimit = getElevenLabsTtsCharacterLimit(ttsModel);
      if (
        !isMessageSpeechSourceEligible({
          role: message.role,
          isStreaming: message.isStreaming !== 0,
          text: sourceText,
          maxSourceChars: ttsCharacterLimit,
        })
      ) {
        if (sourceText.length > ttsCharacterLimit) {
          return yield* new MessageSpeechError({ reason: "source_too_long" });
        }
        return yield* new MessageSpeechError({ reason: "message_unavailable" });
      }

      const sourceTextHash = NodeCrypto.createHash("sha256")
        .update(sourceText, "utf8")
        .digest("hex");
      const scriptRecipeHash = NodeCrypto.createHash("sha256")
        .update(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            version: SPEECH_SCRIPT_RECIPE_VERSION,
            modelSelection: settings.textGenerationModelSelection,
          }),
          "utf8",
        )
        .digest("hex");
      const cachedRows = yield* findCachedSpeech(request.messageId);
      const cached = cachedRows[0];
      // An agent recording is event-owned: a projection replay rebuilds its
      // row from the original thread.message-sent event, so this on-demand
      // path must never overwrite it (or delete its file). Serve it as-is —
      // it already is the spoken form of this message.
      if (cached && cached.origin === "agent") {
        return toAttachment(cached);
      }
      if (
        cached &&
        isMessageSpeechCacheReusable({
          cache: cached,
          sourceTextHash,
          scriptRecipeHash,
          voiceId,
          ttsModel,
        })
      ) {
        const cachedPath = resolveSpeechPath(cached.speechId);
        if (
          cachedPath &&
          (yield* fileSystem.exists(cachedPath).pipe(Effect.orElseSucceed(() => false)))
        ) {
          return toAttachment(cached);
        }
      }

      const generated = yield* Effect.scoped(
        Effect.gen(function* () {
          const isolatedCwd = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-message-speech-",
          });
          return yield* textGeneration.generateSpeechScript({
            cwd: isolatedCwd,
            message: sourceText,
            maxScriptChars: ttsCharacterLimit,
            modelSelection: settings.textGenerationModelSelection,
          });
        }),
      ).pipe(Effect.mapError(() => new MessageSpeechError({ reason: "script_failed" })));
      const transcript = generated.script.trim();
      if (transcript.length === 0 || transcript.length > ttsCharacterLimit) {
        return yield* new MessageSpeechError({ reason: "script_failed" });
      }

      const audioBytes = yield* synthesizeElevenLabsSpeech({
        httpClient,
        apiKey: apiKey.value,
        voiceId,
        ttsModel,
        text: transcript,
      }).pipe(Effect.mapError(() => new MessageSpeechError({ reason: "provider_failed" })));

      // Synthesis can be slow. Revalidate the exact source before committing an
      // attachment so a message edit, deletion, or agent recording that landed
      // while the provider ran wins deterministically.
      const currentMessageRows = yield* findMessage(request.messageId);
      const currentMessage = currentMessageRows[0];
      if (
        currentMessage === undefined ||
        currentMessage.threadId !== message.threadId ||
        currentMessage.role !== "assistant" ||
        currentMessage.isStreaming !== 0 ||
        currentMessage.text !== message.text
      ) {
        return yield* new MessageSpeechError({ reason: "message_unavailable" });
      }
      const currentSpeechRows = yield* findCachedSpeech(request.messageId);
      const currentSpeech = currentSpeechRows[0];
      if (currentSpeech?.origin === "agent") {
        return toAttachment(currentSpeech);
      }

      const speechId = createAttachmentId(message.threadId);
      const speechPath = speechId ? resolveSpeechPath(speechId) : null;
      if (!speechId || !speechPath) {
        return yield* storageError();
      }
      const createdAt = DateTime.formatIso(yield* DateTime.now);

      yield* fileSystem.makeDirectory(serverConfig.attachmentsDir, { recursive: true }).pipe(
        Effect.andThen(fileSystem.writeFile(speechPath, audioBytes)),
        Effect.mapError(storageError),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : fileSystem.remove(speechPath, { force: true }).pipe(Effect.ignore),
        ),
      );

      return {
        speechId,
        transcript,
        mimeType: SPEECH_MIME_TYPE,
        sizeBytes: audioBytes.byteLength,
        sourceTextHash,
        scriptRecipeHash,
        voiceId,
        ttsModel,
        origin: "user",
        createdAt,
      } satisfies MessageSpeechAttachment;
    });

    return MessageSpeech.of({
      available,
      synthesize: (request) =>
        synthesisLocks.withMessageLock(request.messageId, synthesizeUnlocked(request)),
      deleteAttachment: (speechId) => {
        const speechPath = resolveSpeechPath(speechId);
        return speechPath === null
          ? Effect.fail(storageError())
          : fileSystem.remove(speechPath, { force: true }).pipe(Effect.mapError(storageError));
      },
    });
  }),
);
