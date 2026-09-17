// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AGENT_VOICE_REPLY_MAX_SCRIPT_CHARS,
  AgentVoiceReplyError,
  MESSAGE_SPEECH_MAX_SCRIPT_CHARS,
  type SpeechAudioMimeType,
  type MessageSpeechAttachment,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { createAttachmentId } from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { getTtsCharacterLimit, resolveAgentReplyTtsProfile } from "./ttsProfile.ts";
import { TtsService } from "./TtsService.ts";
import { appendSpeechAudio } from "./speechChunks.ts";
import { estimateSpeechDurationMs } from "./speechDuration.ts";
import { speechFailureReasonFor, speechFileExtension } from "./ttsTypes.ts";

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
 * message. One staged reply per thread — a second call in the same turn
 * appends to it (the segments play in call order as one recording), while a
 * call from a newer turn replaces it.
 *
 * The audio is written to the attachments directory at stage time so the later
 * attach command can stay metadata-only, mirroring how user image attachments
 * are persisted by the normalizer before their event is recorded. Consumers
 * take entries with the atomic claim/discard operations below — never
 * peek-then-remove, which would race a concurrent re-stage and cross-wire
 * two recordings.
 */
export interface AgentVoiceReplyShape {
  /** Whether the agent-reply profile's provider currently holds a key. Read per call. */
  readonly available: Effect.Effect<boolean>;
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
  available: Effect.succeed(false),
  stage: () => Effect.fail(new AgentVoiceReplyError({ reason: "unavailable" })),
  claimStagedForTurn: () => Effect.succeed(undefined),
  discardStagedForTurn: () => Effect.void,
  discardStaged: () => Effect.void,
});

export const layer = Layer.effect(
  AgentVoiceReply,
  Effect.gen(function* () {
    const tts = yield* TtsService;
    const fileSystem = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const staged = yield* SynchronizedRef.make<ReadonlyMap<ThreadId, StagedAgentVoiceReply>>(
      new Map(),
    );

    const resolveSpeechPath = (speechId: string, mimeType: SpeechAudioMimeType) =>
      resolveAttachmentRelativePath({
        attachmentsDir: serverConfig.attachmentsDir,
        relativePath: `${speechId}${speechFileExtension(mimeType)}`,
      });

    const removeAudioFile = (
      attachment: Pick<MessageSpeechAttachment, "speechId" | "mimeType">,
    ) => {
      const path = resolveSpeechPath(attachment.speechId, attachment.mimeType);
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
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(() => new AgentVoiceReplyError({ reason: "storage_failed" })),
        );
        const profile = resolveAgentReplyTtsProfile(settings.voice, tts.environmentDefaults);
        if (!(yield* tts.isConfigured(profile.provider).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* new AgentVoiceReplyError({ reason: "unavailable" });
        }
        // Vendor-qualified so a persisted recording names where it came from.
        const ttsModel = `${profile.provider}:${profile.modelId}`;
        const voiceId = profile.voiceId;

        const script = input.script.trim();
        if (script.length === 0) {
          return yield* new AgentVoiceReplyError({ reason: "empty_script" });
        }
        const characterLimit = Math.min(
          AGENT_VOICE_REPLY_MAX_SCRIPT_CHARS,
          getTtsCharacterLimit(profile),
        );
        if (script.length > characterLimit) {
          return yield* new AgentVoiceReplyError({ reason: "script_too_long" });
        }

        const turnId = yield* resolveActiveTurnId(input.threadId);
        if (turnId === null) {
          return yield* new AgentVoiceReplyError({ reason: "turn_unavailable" });
        }
        const { bytes: audioBytes, mimeType } = yield* tts
          .synthesize({ profile, text: script })
          .pipe(
            Effect.mapError(
              (error) => new AgentVoiceReplyError({ reason: speechFailureReasonFor(error) }),
            ),
          );

        // Synthesis can take a while; if the thread was steered to a
        // different turn in the meantime, this recording belongs to a turn
        // that will never complete normally — refuse instead of staging a
        // reply that could attach to the wrong turn.
        const turnIdAfterSynthesis = yield* resolveActiveTurnId(input.threadId);
        if (turnIdAfterSynthesis === null || turnIdAfterSynthesis !== turnId) {
          return yield* new AgentVoiceReplyError({ reason: "turn_unavailable" });
        }

        yield* fileSystem
          .makeDirectory(serverConfig.attachmentsDir, { recursive: true })
          .pipe(Effect.mapError(() => new AgentVoiceReplyError({ reason: "storage_failed" })));

        const storeSegment = (bytes: Uint8Array) =>
          Effect.gen(function* () {
            const speechId = createAttachmentId(input.threadId);
            const speechPath = speechId ? resolveSpeechPath(speechId, mimeType) : null;
            if (!speechId || !speechPath) {
              return yield* new AgentVoiceReplyError({ reason: "storage_failed" });
            }
            yield* fileSystem
              .writeFile(speechPath, bytes)
              .pipe(Effect.mapError(() => new AgentVoiceReplyError({ reason: "storage_failed" })));
            return speechId;
          });

        // The whole read-merge-write runs while holding the map's semaphore,
        // which the claim/discard operations also take: a consumer either
        // sees the fully merged entry or none at all. Touching a still-staged
        // entry cannot race a consumer for the same reason as before —
        // ingestion claims an entry (removing it from the map) before
        // dispatching, so anything still present here is unclaimed. The
        // superseded file is deleted only after the new entry is committed,
        // so an interrupt can at worst orphan a file, never leave the map
        // pointing at a deleted one.
        const staged_ = yield* SynchronizedRef.modifyEffect(staged, (entries) =>
          Effect.gen(function* () {
            const previous = entries.get(input.threadId);
            const superseded = previous?.attachment;

            // A second call in the same turn appends: the recordings play in
            // call order as one stream. An entry left by an older turn is
            // replaced instead.
            if (previous !== undefined && previous.turnId === turnId) {
              const transcript = `${previous.attachment.transcript}\n\n${script}`;
              if (transcript.length > MESSAGE_SPEECH_MAX_SCRIPT_CHARS) {
                return yield* new AgentVoiceReplyError({ reason: "script_too_long" });
              }
              const previousPath = resolveSpeechPath(
                previous.attachment.speechId,
                previous.attachment.mimeType,
              );
              if (!previousPath) {
                return yield* new AgentVoiceReplyError({ reason: "storage_failed" });
              }
              const previousBytes = yield* fileSystem
                .readFile(previousPath)
                .pipe(
                  Effect.mapError(() => new AgentVoiceReplyError({ reason: "storage_failed" })),
                );
              const mergedBytes =
                previous.attachment.mimeType === mimeType
                  ? appendSpeechAudio(previousBytes, audioBytes, mimeType)
                  : null;
              if (mergedBytes === null) {
                return yield* new AgentVoiceReplyError({ reason: "storage_failed" });
              }
              // The merge lands under a fresh id so a failed write leaves the
              // already staged recording intact. voiceId, ttsModel and
              // createdAt stay those of the first segment — deliberate: they
              // describe where the recording started, even if the voice
              // settings changed between calls.
              const speechId = yield* storeSegment(mergedBytes);
              const attachment: MessageSpeechAttachment = {
                ...previous.attachment,
                speechId,
                transcript: transcript as MessageSpeechAttachment["transcript"],
                sizeBytes: mergedBytes.byteLength as MessageSpeechAttachment["sizeBytes"],
                durationMs: estimateSpeechDurationMs(
                  mergedBytes,
                  mimeType,
                ) as MessageSpeechAttachment["durationMs"],
                sourceTextHash: NodeCrypto.createHash("sha256")
                  .update(transcript, "utf8")
                  .digest("hex") as MessageSpeechAttachment["sourceTextHash"],
              };
              const next = new Map(entries);
              next.set(input.threadId, { turnId, attachment });
              return [{ attachment, superseded }, next] as const;
            }

            const speechId = yield* storeSegment(audioBytes);
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            const attachment: MessageSpeechAttachment = {
              speechId,
              transcript: script as MessageSpeechAttachment["transcript"],
              mimeType,
              sizeBytes: audioBytes.byteLength as MessageSpeechAttachment["sizeBytes"],
              durationMs: estimateSpeechDurationMs(
                audioBytes,
                mimeType,
              ) as MessageSpeechAttachment["durationMs"],
              sourceTextHash: NodeCrypto.createHash("sha256")
                .update(script, "utf8")
                .digest("hex") as MessageSpeechAttachment["sourceTextHash"],
              voiceId: voiceId as MessageSpeechAttachment["voiceId"],
              ttsModel: ttsModel as MessageSpeechAttachment["ttsModel"],
              origin: "agent",
              createdAt: createdAt as MessageSpeechAttachment["createdAt"],
            };
            const next = new Map(entries);
            next.set(input.threadId, { turnId, attachment });
            return [{ attachment, superseded }, next] as const;
          }),
        );
        if (staged_.superseded !== undefined) {
          yield* removeAudioFile(staged_.superseded);
        }
        return staged_.attachment;
      },
    );

    const discardEntry = (entry: StagedAgentVoiceReply | undefined) =>
      entry ? removeAudioFile(entry.attachment) : Effect.void;

    const available = serverSettings.getSettings.pipe(
      Effect.flatMap((settings) =>
        tts.isConfigured(
          resolveAgentReplyTtsProfile(settings.voice, tts.environmentDefaults).provider,
        ),
      ),
      Effect.orElseSucceed(() => false),
    );

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
