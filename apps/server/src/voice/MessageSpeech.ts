// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  MESSAGE_SPEECH_MAX_SOURCE_CHARS,
  MessageId,
  MessageSpeechFailureReason,
  SpeechAudioMimeType,
  type MessageSpeechSynthesisRequest,
  type MessageSpeechSynthesisResult,
  type MessageSpeechThreadState,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { messageArtifactTextHash } from "../messageArtifacts/identity.ts";
import { makeMessageArtifactLockCoordinator } from "../messageArtifacts/lock.ts";
import { MessageSpeechScript } from "../messageArtifacts/MessageSpeechScript.ts";
import {
  currentArtifactSourceCondition,
  findMessageArtifactSource,
} from "../messageArtifacts/source.ts";
import { readThreadSummaries } from "../messageArtifacts/threadSummaries.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { estimateSpeechDurationMs } from "./speechDuration.ts";
import { getTtsCharacterLimit, resolveListeningTtsProfile } from "./ttsProfile.ts";
import { TtsService } from "./TtsService.ts";
import {
  isSpeechAudioMimeType,
  MP3_MIME_TYPE,
  speechFailureReasonFor,
  speechFileExtension,
} from "./ttsTypes.ts";

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

/** A `fork_message_speech` row; `scriptRecipeHash` is null for agent recordings. */
interface MessageSpeechRow extends Omit<MessageSpeechCacheRow, "scriptRecipeHash"> {
  readonly scriptRecipeHash: string | null;
}

/** A recording the agent made itself (`voice_reply`), with its audio already stored. */
export interface AgentSpeechRecording {
  readonly speechId: string;
  readonly transcript: string;
  readonly mimeType: SpeechAudioMimeType;
  readonly sizeBytes: number;
  readonly durationMs: number | null;
  readonly voiceId: string;
  readonly ttsModel: string;
  readonly createdAt: string;
}

export interface MessageSpeechShape {
  /** Whether the listening profile's provider currently holds a key. Read per call. */
  readonly available: Effect.Effect<boolean>;
  /**
   * Starts the message's listening job, or joins the one already running, and
   * waits for its recording. The job belongs to the server: a caller that
   * goes away does not cancel it, and every thread subscriber sees it pending.
   */
  readonly synthesize: (
    request: MessageSpeechSynthesisRequest,
  ) => Effect.Effect<MessageSpeechSynthesisResult, MessageSpeechError>;
  /** The thread's listening state now, then again after every change to it. */
  readonly streamThread: (threadId: ThreadId) => Stream.Stream<MessageSpeechThreadState>;
  /** Re-sends the thread's state to its subscribers, e.g. after a summary was stored. */
  readonly refreshThread: (threadId: ThreadId) => Effect.Effect<void>;
  /**
   * Removes the recordings (audio files included), speech scripts and
   * summaries of every deleted thread. Idempotent; keyed on the projection's
   * deletion mark, so it also catches up after a crash.
   */
  readonly purgeDeletedThreads: Effect.Effect<void, MessageSpeechError>;
  /**
   * Stores the agent's own recording as the message's speech. It replaces a
   * listening version (whose audio is deleted) and is never replaced by one.
   */
  readonly attachAgentRecording: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly recording: AgentSpeechRecording;
  }) => Effect.Effect<void, MessageSpeechError>;
}

/**
 * On-demand listening versions of assistant messages. A job rewrites the
 * message for the ear (`MessageSpeechScript`), synthesizes it, and stores the
 * recording in `fork_message_speech`. Pending jobs live in memory only, so a
 * server restart drops interrupted requests and they can simply be retried.
 */
export class MessageSpeech extends Context.Service<MessageSpeech, MessageSpeechShape>()(
  "t3/voice/MessageSpeech",
) {}

const MESSAGE_SPEECH_JOB_TIMEOUT = Duration.minutes(3);

const storageError = () => new MessageSpeechError({ reason: "storage_failed" });

const toSynthesisResult = (row: MessageSpeechRow): MessageSpeechSynthesisResult => ({
  messageId: MessageId.make(row.messageId),
  speechId: row.speechId as MessageSpeechSynthesisResult["speechId"],
  transcript: row.transcript as MessageSpeechSynthesisResult["transcript"],
  // Rows are only written here, so anything unrecognized is a hand edit; MP3
  // is the safe reading of it.
  mimeType: isSpeechAudioMimeType(row.mimeType) ? row.mimeType : MP3_MIME_TYPE,
  sizeBytes: row.sizeBytes as MessageSpeechSynthesisResult["sizeBytes"],
  ...(row.durationMs !== null
    ? { durationMs: row.durationMs as NonNullable<MessageSpeechSynthesisResult["durationMs"]> }
    : {}),
  origin: row.origin === "agent" ? "agent" : "user",
  createdAt: row.createdAt as MessageSpeechSynthesisResult["createdAt"],
});

interface MessageSpeechJob {
  readonly threadId: string;
  readonly done: Deferred.Deferred<MessageSpeechSynthesisResult, MessageSpeechError>;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const tts = yield* TtsService;
  const speechScripts = yield* MessageSpeechScript;
  // Jobs outlive the request that started them; they end with the server.
  const jobScope = yield* Scope.Scope;
  const jobs = new Map<string, MessageSpeechJob>();
  // Thread ids whose listening state changed.
  const changes = yield* PubSub.unbounded<string>();
  const publishChange = (threadId: string) => PubSub.publish(changes, threadId).pipe(Effect.asVoid);

  const resolveSpeechPath = (speechId: string, mimeType: SpeechAudioMimeType) =>
    resolveAttachmentRelativePath({
      attachmentsDir: serverConfig.attachmentsDir,
      relativePath: `${speechId}${speechFileExtension(mimeType)}`,
    });

  const findSpeechRow = (messageId: string) =>
    sql<MessageSpeechRow>`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        speech_id AS "speechId",
        transcript,
        mime_type AS "mimeType",
        size_bytes AS "sizeBytes",
        duration_ms AS "durationMs",
        source_text_hash AS "sourceTextHash",
        script_recipe_hash AS "scriptRecipeHash",
        voice_id AS "voiceId",
        tts_model AS "ttsModel",
        origin,
        created_at AS "createdAt"
      FROM fork_message_speech
      WHERE message_id = ${messageId}
    `.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(storageError),
    );

  // Callers only hold the id, so both containers are removed; at most one exists.
  const deleteSpeechFile = (speechId: string) =>
    Effect.forEach(
      SpeechAudioMimeType.literals,
      (mimeType) => {
        const speechPath = resolveSpeechPath(speechId, mimeType);
        return speechPath === null
          ? Effect.void
          : fileSystem.remove(speechPath, { force: true }).pipe(Effect.ignore);
      },
      { discard: true },
    );

  const runJob = Effect.fn("MessageSpeech.runJob")(function* (messageId: MessageId) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => new MessageSpeechError({ reason: "script_failed" })),
    );
    const profile = resolveListeningTtsProfile(settings.voice, tts.environmentDefaults);
    if (!(yield* tts.isConfigured(profile.provider))) {
      return yield* new MessageSpeechError({ reason: "unavailable" });
    }
    // The vendor is part of the model so a cache hit for one provider's model
    // id never serves another provider's audio.
    const ttsModel = `${profile.provider}:${profile.modelId}`;
    const voiceId = profile.voiceId;
    const maxChars = getTtsCharacterLimit(profile);

    const source = yield* findMessageArtifactSource(sql, messageId).pipe(
      Effect.mapError(storageError),
    );
    if (source === undefined) {
      return yield* new MessageSpeechError({ reason: "message_unavailable" });
    }
    const sourceFailure = getMessageSpeechSourceFailureReason({
      role: source.role,
      isStreaming: source.streaming !== 0,
      text: source.text,
      maxSourceChars: maxChars,
    });
    if (sourceFailure !== null) {
      return yield* new MessageSpeechError({ reason: sourceFailure });
    }
    const sourceTextHash = messageArtifactTextHash(source.text.trim());
    const scriptRecipeHash = messageSpeechRecipeHash({
      modelSelection: settings.textGenerationModelSelection,
      instructions: profile.instructions,
    });

    const prior = yield* findSpeechRow(messageId);
    // The agent's own recording already is the spoken form of the message;
    // listening never replaces it.
    if (prior?.origin === "agent") return toSynthesisResult(prior);
    if (
      prior !== undefined &&
      prior.scriptRecipeHash !== null &&
      isMessageSpeechCacheReusable({
        cache: { ...prior, scriptRecipeHash: prior.scriptRecipeHash },
        sourceTextHash,
        scriptRecipeHash,
        voiceId,
        ttsModel,
      })
    ) {
      const priorPath = resolveSpeechPath(
        prior.speechId,
        isSpeechAudioMimeType(prior.mimeType) ? prior.mimeType : MP3_MIME_TYPE,
      );
      if (
        priorPath !== null &&
        (yield* fileSystem.exists(priorPath).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return toSynthesisResult(prior);
      }
    }

    const script = yield* speechScripts.generate({
      messageId,
      maxScriptChars: maxChars,
      modelSelection: settings.textGenerationModelSelection,
      instructions: profile.instructions,
    });
    if (script.sourceTextHash !== sourceTextHash) {
      return yield* new MessageSpeechError({ reason: "message_unavailable" });
    }
    const synthesized = yield* tts
      .synthesize({ profile, text: script.script })
      .pipe(
        Effect.mapError(
          (error) => new MessageSpeechError({ reason: speechFailureReasonFor(error) }),
        ),
      );

    const speechId = createAttachmentId(source.threadId);
    const speechPath = speechId === null ? null : resolveSpeechPath(speechId, synthesized.mimeType);
    if (speechId === null || speechPath === null) {
      return yield* storageError();
    }
    yield* fileSystem.makeDirectory(serverConfig.attachmentsDir, { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFile(speechPath, synthesized.bytes)),
      Effect.mapError(storageError),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : deleteSpeechFile(speechId))),
    );
    const row: MessageSpeechRow = {
      messageId,
      threadId: source.threadId,
      speechId,
      transcript: script.script,
      mimeType: synthesized.mimeType,
      sizeBytes: synthesized.bytes.byteLength,
      durationMs: estimateSpeechDurationMs(synthesized.bytes, synthesized.mimeType),
      sourceTextHash,
      scriptRecipeHash,
      voiceId,
      ttsModel,
      origin: "user",
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };

    // Synthesis is slow: store only while the message still has the text the
    // script came from, and never over a recording the agent made meanwhile.
    const stored = yield* sql`
      INSERT INTO fork_message_speech (
        message_id,
        thread_id,
        speech_id,
        transcript,
        mime_type,
        size_bytes,
        duration_ms,
        source_text_hash,
        script_recipe_hash,
        voice_id,
        tts_model,
        origin,
        created_at
      )
      SELECT
        ${row.messageId},
        ${row.threadId},
        ${row.speechId},
        ${row.transcript},
        ${row.mimeType},
        ${row.sizeBytes},
        ${row.durationMs},
        ${row.sourceTextHash},
        ${row.scriptRecipeHash},
        ${row.voiceId},
        ${row.ttsModel},
        ${row.origin},
        ${row.createdAt}
      WHERE ${currentArtifactSourceCondition(sql, source)}
      ON CONFLICT(message_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        speech_id = excluded.speech_id,
        transcript = excluded.transcript,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        duration_ms = excluded.duration_ms,
        source_text_hash = excluded.source_text_hash,
        script_recipe_hash = excluded.script_recipe_hash,
        voice_id = excluded.voice_id,
        tts_model = excluded.tts_model,
        origin = excluded.origin,
        created_at = excluded.created_at
      WHERE fork_message_speech.origin <> 'agent'
      RETURNING message_id
    `.pipe(
      Effect.mapError(storageError),
      Effect.tapError(() => deleteSpeechFile(speechId)),
    );
    if (stored.length === 0) {
      yield* deleteSpeechFile(speechId);
      const current = yield* findSpeechRow(messageId);
      if (current?.origin === "agent") return toSynthesisResult(current);
      return yield* new MessageSpeechError({ reason: "message_unavailable" });
    }
    if (prior !== undefined && prior.speechId !== speechId) {
      yield* deleteSpeechFile(prior.speechId);
    }
    return toSynthesisResult(row);
  });

  const startJob = Effect.fn("MessageSpeech.startJob")(function* (
    messageId: MessageId,
    threadId: string,
  ) {
    const done = yield* Deferred.make<MessageSpeechSynthesisResult, MessageSpeechError>();
    jobs.set(messageId, { threadId, done });
    yield* publishChange(threadId);
    yield* runJob(messageId).pipe(
      Effect.timeoutOrElse({
        duration: MESSAGE_SPEECH_JOB_TIMEOUT,
        orElse: () => Effect.fail(new MessageSpeechError({ reason: "provider_failed" })),
      }),
      Effect.tapError((error) =>
        Effect.logWarning("message speech job failed", {
          messageId,
          threadId,
          reason: error.reason,
        }),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("message speech job died", {
          messageId,
          threadId,
          cause: Cause.pretty(Cause.die(defect)),
        }).pipe(Effect.andThen(Effect.fail(new MessageSpeechError({ reason: "provider_failed" })))),
      ),
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(done, exit)),
      Effect.onInterrupt(() => Deferred.interrupt(done)),
      // Settled before the job is dropped, so a request arriving in between
      // joins the finished result instead of starting over.
      Effect.ensuring(
        Effect.sync(() => {
          if (jobs.get(messageId)?.done === done) jobs.delete(messageId);
        }).pipe(Effect.andThen(publishChange(threadId))),
      ),
      Effect.forkIn(jobScope),
    );
    return done;
  });

  const synthesize = Effect.fn("MessageSpeech.synthesize")(function* (
    request: MessageSpeechSynthesisRequest,
  ) {
    const running = jobs.get(request.messageId);
    if (running !== undefined) return yield* Deferred.await(running.done);
    const source = yield* findMessageArtifactSource(sql, request.messageId).pipe(
      Effect.mapError(storageError),
    );
    if (source === undefined) {
      return yield* new MessageSpeechError({ reason: "message_unavailable" });
    }
    // Cheap checks first, so an ineligible message never shows as pending.
    const sourceFailure = getMessageSpeechSourceFailureReason({
      role: source.role,
      isStreaming: source.streaming !== 0,
      text: source.text,
    });
    if (sourceFailure !== null) {
      return yield* new MessageSpeechError({ reason: sourceFailure });
    }
    const done =
      jobs.get(request.messageId)?.done ?? (yield* startJob(request.messageId, source.threadId));
    return yield* Deferred.await(done);
  });

  const readThread = Effect.fn("MessageSpeech.readThread")(function* (threadId: ThreadId) {
    const rows = yield* sql<MessageSpeechRow & { readonly messageText: string | null }>`
      SELECT
        speech.message_id AS "messageId",
        speech.thread_id AS "threadId",
        speech.speech_id AS "speechId",
        speech.transcript,
        speech.mime_type AS "mimeType",
        speech.size_bytes AS "sizeBytes",
        speech.duration_ms AS "durationMs",
        speech.source_text_hash AS "sourceTextHash",
        speech.script_recipe_hash AS "scriptRecipeHash",
        speech.voice_id AS "voiceId",
        speech.tts_model AS "ttsModel",
        speech.origin,
        speech.created_at AS "createdAt",
        json_extract(message.payload_json, '$.text') AS "messageText"
      FROM fork_message_speech AS speech
      INNER JOIN orchestration_v2_projection_messages AS message
        ON message.message_id = speech.message_id
      INNER JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = speech.thread_id
        AND thread.deleted_at IS NULL
      WHERE speech.thread_id = ${threadId}
      ORDER BY speech.created_at, speech.message_id
    `;
    const recordings = rows
      .filter(
        (row) =>
          row.origin === "agent" ||
          (row.messageText !== null &&
            row.sourceTextHash === messageArtifactTextHash(row.messageText.trim())),
      )
      .map(toSynthesisResult);
    const pendingMessageIds = [...jobs]
      .filter(([, job]) => job.threadId === threadId)
      .map(([messageId]) => MessageId.make(messageId));
    const summaries = yield* readThreadSummaries(sql, threadId);
    const state: MessageSpeechThreadState = {
      threadId,
      recordings,
      pendingMessageIds,
      summaries,
    };
    return state;
  });

  const streamThread: MessageSpeechShape["streamThread"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the first read, so no change can fall in between.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.make(threadId),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === threadId),
          ),
        ).pipe(
          // Each emission is a fresh whole state, so skipped or merged
          // notifications can never leave a subscriber behind.
          Stream.mapEffect(() =>
            readThread(threadId).pipe(
              Effect.catch((error) =>
                Effect.logWarning("message speech state read failed", { threadId, error }).pipe(
                  Effect.as(null),
                ),
              ),
            ),
          ),
          Stream.filter((state): state is MessageSpeechThreadState => state !== null),
        );
      }),
    );

  const available = serverSettings.getSettings.pipe(
    Effect.flatMap((settings) =>
      tts.isConfigured(
        resolveListeningTtsProfile(settings.voice, tts.environmentDefaults).provider,
      ),
    ),
    Effect.orElseSucceed(() => false),
  );

  const attachAgentRecording: MessageSpeechShape["attachAgentRecording"] = Effect.fn(
    "MessageSpeech.attachAgentRecording",
  )(function* ({ threadId, messageId, recording }) {
    const prior = yield* findSpeechRow(messageId);
    yield* sql`
      INSERT INTO fork_message_speech (
        message_id,
        thread_id,
        speech_id,
        transcript,
        mime_type,
        size_bytes,
        duration_ms,
        source_text_hash,
        script_recipe_hash,
        voice_id,
        tts_model,
        origin,
        created_at
      )
      VALUES (
        ${messageId},
        ${threadId},
        ${recording.speechId},
        ${recording.transcript},
        ${recording.mimeType},
        ${recording.sizeBytes},
        ${recording.durationMs},
        ${messageArtifactTextHash(recording.transcript.trim())},
        NULL,
        ${recording.voiceId},
        ${recording.ttsModel},
        'agent',
        ${recording.createdAt}
      )
      ON CONFLICT(message_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        speech_id = excluded.speech_id,
        transcript = excluded.transcript,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        duration_ms = excluded.duration_ms,
        source_text_hash = excluded.source_text_hash,
        script_recipe_hash = excluded.script_recipe_hash,
        voice_id = excluded.voice_id,
        tts_model = excluded.tts_model,
        origin = excluded.origin,
        created_at = excluded.created_at
    `.pipe(Effect.mapError(storageError));
    if (prior !== undefined && prior.speechId !== recording.speechId) {
      yield* deleteSpeechFile(prior.speechId);
    }
    yield* publishChange(threadId);
  });

  const purgeDeletedThreads = Effect.gen(function* () {
    const speechIds = yield* sql<{ readonly speechId: string }>`
      SELECT speech.speech_id AS "speechId"
      FROM fork_message_speech AS speech
      INNER JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = speech.thread_id
      WHERE thread.deleted_at IS NOT NULL
    `;
    // Files first: a crash in between leaves rows that the next pass retries.
    yield* Effect.forEach(speechIds, (row) => deleteSpeechFile(row.speechId), { discard: true });
    yield* sql`
      DELETE FROM fork_message_speech WHERE thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
      )
    `;
    yield* sql`
      DELETE FROM fork_message_speech_scripts WHERE thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
      )
    `;
    yield* sql`
      DELETE FROM fork_message_summaries WHERE thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
      )
    `;
  }).pipe(Effect.mapError(storageError), Effect.withSpan("MessageSpeech.purgeDeletedThreads"));

  return MessageSpeech.of({
    available,
    synthesize,
    streamThread,
    refreshThread: publishChange,
    purgeDeletedThreads,
    attachAgentRecording,
  });
});

export const layer = Layer.effect(MessageSpeech, make);
