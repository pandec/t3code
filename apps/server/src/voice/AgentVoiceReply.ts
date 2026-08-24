// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AGENT_VOICE_REPLY_MAX_SCRIPT_CHARS,
  AgentVoiceReplyError,
  type MessageSpeechAttachment,
  type ThreadId,
  type TurnId,
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
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
 * A recording staged by the voice_reply MCP tool, bound to the turn that was
 * active when it was staged. Staging fails when no active turn can be
 * identified, so a recording can never attach to a turn other than its own.
 */
export interface StagedAgentVoiceReply {
  readonly turnId: TurnId;
  readonly attachment: MessageSpeechAttachment;
}

/**
 * Agent-staged voice replies. The `voice_reply` MCP tool synthesizes a
 * recording mid-turn and parks it here; provider-runtime ingestion claims it
 * when its turn completes and attaches it to that turn's final assistant
 * message. One staged reply per thread — a second call replaces the first.
 *
 * The MP3 is written to the attachments directory at stage time so the later
 * attach command can stay metadata-only, mirroring how user image attachments
 * are persisted by the normalizer before their event is recorded. Consumers
 * take entries with the atomic claim/discard operations below — never
 * peek-then-remove, which would race a concurrent re-stage and cross-wire
 * two recordings.
 */
export interface AgentVoiceReplyShape {
  readonly available: boolean;
  readonly stage: (input: {
    readonly threadId: ThreadId;
    readonly script: string;
  }) => Effect.Effect<MessageSpeechAttachment, AgentVoiceReplyError>;
  /**
   * Atomically removes and returns the reply staged for exactly this turn.
   * The caller owns the entry (and its audio file) from then on.
   */
  readonly claimStagedForTurn: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<StagedAgentVoiceReply | undefined>;
  /** Claims the turn's staged reply, if any, and deletes its audio file. */
  readonly discardStagedForTurn: (threadId: ThreadId, turnId: TurnId) => Effect.Effect<void>;
  /** Removes whatever reply is staged for the thread and deletes its audio file. */
  readonly discardStaged: (threadId: ThreadId) => Effect.Effect<void>;
}

export class AgentVoiceReply extends Context.Service<AgentVoiceReply, AgentVoiceReplyShape>()(
  "t3/voice/AgentVoiceReply",
) {}

/** Inert instance for tests and harnesses that do not exercise voice replies. */
export const layerNoop = Layer.succeed(AgentVoiceReply, {
  available: false,
  stage: () => Effect.fail(new AgentVoiceReplyError({ reason: "unavailable" })),
  claimStagedForTurn: () => Effect.succeed(undefined),
  discardStagedForTurn: () => Effect.void,
  discardStaged: () => Effect.void,
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
    const sql = yield* SqlClient.SqlClient;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const staged = yield* SynchronizedRef.make<ReadonlyMap<ThreadId, StagedAgentVoiceReply>>(
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

    /**
     * The thread's active turn, read from the projection. Fails closed: a
     * missing or unreadable session yields null and staging refuses to
     * proceed, because a recording bound to a guessed turn can attach to the
     * wrong one.
     */
    const resolveActiveTurnId = (threadId: ThreadId) =>
      sql<{ readonly activeTurnId: string | null }>`
        SELECT active_turn_id AS "activeTurnId"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `.pipe(
        Effect.map((rows) => (rows[0]?.activeTurnId ?? null) as TurnId | null),
        Effect.orElseSucceed((): TurnId | null => null),
      );

    const takeMatching = (threadId: ThreadId, matches: (entry: StagedAgentVoiceReply) => boolean) =>
      SynchronizedRef.modify(staged, (entries) => {
        const current = entries.get(threadId);
        if (!current || !matches(current)) return [undefined, entries] as const;
        const next = new Map(entries);
        next.delete(threadId);
        return [current, next] as const;
      });

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
        if (script.length === 0) {
          return yield* new AgentVoiceReplyError({ reason: "empty_script" });
        }
        const characterLimit = Math.min(
          AGENT_VOICE_REPLY_MAX_SCRIPT_CHARS,
          getElevenLabsTtsCharacterLimit(ttsModel),
        );
        if (script.length > characterLimit) {
          return yield* new AgentVoiceReplyError({ reason: "script_too_long" });
        }

        const turnId = yield* resolveActiveTurnId(input.threadId);
        if (turnId === null) {
          return yield* new AgentVoiceReplyError({ reason: "turn_unavailable" });
        }
        const audioBytes = yield* synthesizeElevenLabsSpeech({
          httpClient,
          apiKey: apiKey.value,
          voiceId,
          ttsModel,
          text: script,
        }).pipe(Effect.mapError(() => new AgentVoiceReplyError({ reason: "provider_failed" })));

        // Synthesis can take a while; if the thread was steered to a
        // different turn in the meantime, this recording belongs to a turn
        // that will never complete normally — refuse instead of staging a
        // reply that could attach to the wrong turn.
        const turnIdAfterSynthesis = yield* resolveActiveTurnId(input.threadId);
        if (turnIdAfterSynthesis === null || turnIdAfterSynthesis !== turnId) {
          return yield* new AgentVoiceReplyError({ reason: "turn_unavailable" });
        }

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

        // Replacing a still-staged entry deletes its file. This cannot race a
        // consumer: ingestion claims an entry (removing it from the map)
        // before dispatching, so anything still present here is unclaimed.
        const replaced = yield* SynchronizedRef.modify(staged, (entries) => {
          const previous = entries.get(input.threadId);
          const next = new Map(entries);
          next.set(input.threadId, { turnId, attachment });
          return [previous, next] as const;
        });
        if (replaced) {
          yield* removeAudioFile(replaced.attachment.speechId);
        }
        return attachment;
      },
    );

    const discardEntry = (entry: StagedAgentVoiceReply | undefined) =>
      entry ? removeAudioFile(entry.attachment.speechId) : Effect.void;

    return AgentVoiceReply.of({
      available,
      stage,
      claimStagedForTurn: (threadId, turnId) =>
        takeMatching(threadId, (entry) => entry.turnId === turnId),
      discardStagedForTurn: (threadId, turnId) =>
        takeMatching(threadId, (entry) => entry.turnId === turnId).pipe(
          Effect.flatMap(discardEntry),
        ),
      discardStaged: (threadId) =>
        takeMatching(threadId, () => true).pipe(Effect.flatMap(discardEntry)),
    });
  }),
);
