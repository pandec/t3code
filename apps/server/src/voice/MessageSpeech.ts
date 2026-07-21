// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  MESSAGE_SPEECH_MAX_SOURCE_CHARS,
  type MessageSpeechSynthesisRequest,
  type MessageSpeechSynthesisResult,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";

import { createAttachmentId } from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";

const ELEVENLABS_TEXT_TO_SPEECH_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_TEXT_TO_SPEECH_TIMEOUT = "120 seconds";
const DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";
const DEFAULT_ELEVENLABS_TTS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const SPEECH_MIME_TYPE = "audio/mpeg" as const;
const SPEECH_SCRIPT_RECIPE_VERSION = 1;

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
  readonly createdAt: string;
}

interface AssistantMessageRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly role: string;
  readonly text: string;
  readonly isStreaming: number;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
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
    reason: Schema.Literals([
      "unavailable",
      "message_unavailable",
      "source_too_long",
      "script_failed",
      "provider_failed",
      "storage_failed",
    ]),
  },
) {}

export class MessageSpeech extends Context.Service<
  MessageSpeech,
  {
    readonly available: boolean;
    readonly synthesize: (
      request: MessageSpeechSynthesisRequest,
    ) => Effect.Effect<MessageSpeechSynthesisResult, MessageSpeechError>;
  }
>()("t3/voice/MessageSpeech") {}

const storageError = () => new MessageSpeechError({ reason: "storage_failed" });

export const layer = Layer.effect(
  MessageSpeech,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("ELEVENLABS_API_KEY").pipe(Config.option);
    const ttsModel = yield* Config.string("ELEVENLABS_TTS_MODEL").pipe(
      Config.withDefault(DEFAULT_ELEVENLABS_TTS_MODEL),
    );
    const voiceId = yield* Config.string("ELEVENLABS_TTS_VOICE_ID").pipe(
      Config.withDefault(DEFAULT_ELEVENLABS_TTS_VOICE_ID),
    );
    const available = Option.isSome(apiKey) && Redacted.value(apiKey.value).trim().length > 0;
    const httpClient = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const textGeneration = yield* TextGeneration;
    const synthesisLocksRef = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());

    const getSynthesisLock = Effect.fn("MessageSpeech.getSynthesisLock")(function* (
      messageId: string,
    ) {
      const existing = (yield* Ref.get(synthesisLocksRef)).get(messageId);
      if (existing) return existing;
      const created = yield* Semaphore.make(1);
      return yield* Ref.modify(synthesisLocksRef, (locks) => {
        const current = locks.get(messageId);
        if (current) return [current, locks] as const;
        const next = new Map(locks);
        next.set(messageId, created);
        return [created, next] as const;
      });
    });

    const resolveSpeechPath = (speechId: string) =>
      resolveAttachmentRelativePath({
        attachmentsDir: serverConfig.attachmentsDir,
        relativePath: `${speechId}.mp3`,
      });

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
          created_at AS "createdAt"
        FROM projection_message_speech
        WHERE message_id = ${messageId}
        LIMIT 1
      `.pipe(Effect.mapError(storageError));

    const toResult = (row: MessageSpeechCacheRow): MessageSpeechSynthesisResult => ({
      messageId: row.messageId as MessageSpeechSynthesisResult["messageId"],
      speechId: row.speechId,
      transcript: row.transcript as MessageSpeechSynthesisResult["transcript"],
      mimeType: SPEECH_MIME_TYPE,
      sizeBytes: row.sizeBytes as MessageSpeechSynthesisResult["sizeBytes"],
      createdAt: row.createdAt as MessageSpeechSynthesisResult["createdAt"],
    });

    const synthesizeUnlocked = Effect.fn("MessageSpeech.synthesizeUnlocked")(function* (
      request: MessageSpeechSynthesisRequest,
    ) {
      if (!available || Option.isNone(apiKey)) {
        return yield* new MessageSpeechError({ reason: "unavailable" });
      }

      const messageRows = yield* sql<AssistantMessageRow>`
        SELECT
          messages.message_id AS "messageId",
          messages.thread_id AS "threadId",
          messages.role,
          messages.text,
          messages.is_streaming AS "isStreaming",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_thread_messages AS messages
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = messages.thread_id
          AND threads.deleted_at IS NULL
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE messages.message_id = ${request.messageId}
        LIMIT 1
      `.pipe(Effect.mapError(storageError));
      const message = messageRows[0];
      if (!message) {
        return yield* new MessageSpeechError({ reason: "message_unavailable" });
      }

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
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => new MessageSpeechError({ reason: "script_failed" })),
      );
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
          return toResult(cached);
        }
      }

      const cwd = message.worktreePath ?? message.workspaceRoot;
      const generated = yield* textGeneration
        .generateSpeechScript({
          cwd,
          message: sourceText,
          maxScriptChars: ttsCharacterLimit,
          modelSelection: settings.textGenerationModelSelection,
        })
        .pipe(Effect.mapError(() => new MessageSpeechError({ reason: "script_failed" })));
      const transcript = generated.script.trim();
      if (transcript.length === 0 || transcript.length > ttsCharacterLimit) {
        return yield* new MessageSpeechError({ reason: "script_failed" });
      }

      const audioBuffer = yield* httpClient
        .post(
          `${ELEVENLABS_TEXT_TO_SPEECH_URL}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
          {
            headers: { "xi-api-key": Redacted.value(apiKey.value) },
            body: HttpBody.jsonUnsafe({ text: transcript, model_id: ttsModel }),
          },
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.arrayBuffer),
          Effect.timeout(ELEVENLABS_TEXT_TO_SPEECH_TIMEOUT),
          Effect.mapError(() => new MessageSpeechError({ reason: "provider_failed" })),
        );
      const audioBytes = new Uint8Array(audioBuffer);
      if (audioBytes.byteLength === 0) {
        return yield* new MessageSpeechError({ reason: "provider_failed" });
      }

      const speechId = createAttachmentId(message.threadId);
      const speechPath = speechId ? resolveSpeechPath(speechId) : null;
      if (!speechId || !speechPath) {
        return yield* storageError();
      }
      const createdAt = DateTime.formatIso(yield* DateTime.now);

      yield* fileSystem
        .makeDirectory(serverConfig.attachmentsDir, { recursive: true })
        .pipe(
          Effect.andThen(fileSystem.writeFile(speechPath, audioBytes)),
          Effect.mapError(storageError),
        );

      const persistedRows = yield* sql<MessageSpeechCacheRow>`
        INSERT INTO projection_message_speech (
          message_id,
          thread_id,
          speech_id,
          transcript,
          mime_type,
          size_bytes,
          source_text_hash,
          script_recipe_hash,
          voice_id,
          tts_model,
          created_at
        )
        SELECT
          ${message.messageId},
          ${message.threadId},
          ${speechId},
          ${transcript},
          ${SPEECH_MIME_TYPE},
          ${audioBytes.byteLength},
          ${sourceTextHash},
          ${scriptRecipeHash},
          ${voiceId},
          ${ttsModel},
          ${createdAt}
        WHERE EXISTS (
          SELECT 1
          FROM projection_thread_messages AS messages
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = messages.thread_id
            AND threads.deleted_at IS NULL
          WHERE messages.message_id = ${message.messageId}
            AND messages.thread_id = ${message.threadId}
            AND messages.role = 'assistant'
            AND messages.is_streaming = 0
            AND messages.text = ${message.text}
        )
        ON CONFLICT(message_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          speech_id = excluded.speech_id,
          transcript = excluded.transcript,
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          source_text_hash = excluded.source_text_hash,
          script_recipe_hash = excluded.script_recipe_hash,
          voice_id = excluded.voice_id,
          tts_model = excluded.tts_model,
          created_at = excluded.created_at
        RETURNING
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
          created_at AS "createdAt"
      `.pipe(
        Effect.mapError(storageError),
        Effect.tapError(() => fileSystem.remove(speechPath, { force: true }).pipe(Effect.ignore)),
      );

      if (persistedRows.length === 0) {
        yield* fileSystem.remove(speechPath, { force: true }).pipe(Effect.ignore);
        return yield* new MessageSpeechError({ reason: "message_unavailable" });
      }

      if (cached && cached.speechId !== speechId) {
        const previousPath = resolveSpeechPath(cached.speechId);
        if (previousPath) {
          yield* fileSystem.remove(previousPath, { force: true }).pipe(Effect.ignore);
        }
      }

      return {
        messageId: request.messageId,
        speechId,
        transcript,
        mimeType: SPEECH_MIME_TYPE,
        sizeBytes: audioBytes.byteLength,
        createdAt,
      } satisfies MessageSpeechSynthesisResult;
    });

    return MessageSpeech.of({
      available,
      synthesize: (request) =>
        Effect.flatMap(getSynthesisLock(request.messageId), (lock) =>
          lock.withPermit(synthesizeUnlocked(request)),
        ),
    });
  }),
);
