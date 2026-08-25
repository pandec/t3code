// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AGENT_VOICE_REPLY_MAX_SCRIPT_CHARS,
  AgentVoiceReplyError,
  MESSAGE_SPEECH_MAX_SCRIPT_CHARS,
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
 * message. One staged reply per thread — a second call in the same turn
 * appends to it (the segments play in call order as one recording), while a
 * call from a newer turn replaces it.
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

/**
 * Joins two MP3 segments from the same synthesis pipeline into one playable
 * stream. Every ElevenLabs response here is CBR 44.1kHz mono, so bare frame
 * streams concatenate cleanly — but each segment leads with an ID3v2 tag and
 * a Xing/Info header frame that declares that segment's frame count. Both are
 * dropped from both sides (a no-op on an already merged left side): a header
 * frame surviving into the merge caps the reported duration at the first
 * segment, and without one, CBR players derive the correct duration from the
 * file size.
 */
export function appendSpeechAudio(previous: Uint8Array, next: Uint8Array): Uint8Array {
  const left = stripLeadingXingFrame(stripLeadingId3v2Tag(previous));
  const right = stripLeadingXingFrame(stripLeadingId3v2Tag(next));
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

/**
 * Drops a leading Xing/Info header frame. Only the shape this pipeline emits
 * is parsed — MPEG1 Layer III without CRC; anything else needs different
 * bitrate tables and fourcc offsets, so it is returned untouched rather than
 * guessed at. The fourcc sits right after the side info, whose size is fixed
 * per channel mode, so only that offset is probed — matching arbitrary audio
 * bytes by content alone could false-positive.
 */
export function stripLeadingXingFrame(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) {
    return bytes;
  }
  const isMpeg1 = (bytes[1]! & 0x18) === 0x18;
  const isLayer3 = (bytes[1]! & 0x06) === 0x02;
  const hasCrc = (bytes[1]! & 0x01) === 0;
  if (!isMpeg1 || !isLayer3 || hasCrc) {
    return bytes;
  }
  const bitrateIndex = (bytes[2]! >> 4) & 0x0f;
  const sampleRateIndex = (bytes[2]! >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 3) {
    return bytes;
  }
  const bitrate = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][bitrateIndex]!;
  const sampleRate = [44100, 48000, 32000][sampleRateIndex]!;
  const padding = (bytes[2]! >> 1) & 0x01;
  const frameLength = Math.floor((144 * bitrate * 1000) / sampleRate) + padding;
  if (frameLength > bytes.byteLength) {
    return bytes;
  }
  const isMono = (bytes[3]! & 0xc0) === 0xc0;
  const fourccOffset = 4 + (isMono ? 17 : 32);
  const fourcc = String.fromCharCode(...bytes.subarray(fourccOffset, fourccOffset + 4));
  return fourcc === "Xing" || fourcc === "Info" ? bytes.subarray(frameLength) : bytes;
}

export function stripLeadingId3v2Tag(bytes: Uint8Array): Uint8Array {
  if (
    bytes.byteLength < 10 ||
    bytes[0] !== 0x49 || // "I"
    bytes[1] !== 0x44 || // "D"
    bytes[2] !== 0x33 // "3"
  ) {
    return bytes;
  }
  // The tag size is a 28-bit syncsafe integer and excludes the 10-byte header
  // and the optional 10-byte footer signalled by flag bit 0x10.
  const size =
    ((bytes[6]! & 0x7f) << 21) |
    ((bytes[7]! & 0x7f) << 14) |
    ((bytes[8]! & 0x7f) << 7) |
    (bytes[9]! & 0x7f);
  const tagLength = 10 + size + ((bytes[5]! & 0x10) !== 0 ? 10 : 0);
  return tagLength >= bytes.byteLength ? bytes : bytes.subarray(tagLength);
}

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

        yield* fileSystem
          .makeDirectory(serverConfig.attachmentsDir, { recursive: true })
          .pipe(Effect.mapError(() => new AgentVoiceReplyError({ reason: "storage_failed" })));

        const storeSegment = (bytes: Uint8Array) =>
          Effect.gen(function* () {
            const speechId = createAttachmentId(input.threadId);
            const speechPath = speechId ? resolveSpeechPath(speechId) : null;
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
            const supersededSpeechId = previous?.attachment.speechId;

            // A second call in the same turn appends: the recordings play in
            // call order as one stream. An entry left by an older turn is
            // replaced instead.
            if (previous !== undefined && previous.turnId === turnId) {
              const transcript = `${previous.attachment.transcript}\n\n${script}`;
              if (transcript.length > MESSAGE_SPEECH_MAX_SCRIPT_CHARS) {
                return yield* new AgentVoiceReplyError({ reason: "script_too_long" });
              }
              const previousPath = resolveSpeechPath(previous.attachment.speechId);
              if (!previousPath) {
                return yield* new AgentVoiceReplyError({ reason: "storage_failed" });
              }
              const previousBytes = yield* fileSystem
                .readFile(previousPath)
                .pipe(
                  Effect.mapError(() => new AgentVoiceReplyError({ reason: "storage_failed" })),
                );
              const mergedBytes = appendSpeechAudio(previousBytes, audioBytes);
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
                sourceTextHash: NodeCrypto.createHash("sha256")
                  .update(transcript, "utf8")
                  .digest("hex") as MessageSpeechAttachment["sourceTextHash"],
              };
              const next = new Map(entries);
              next.set(input.threadId, { turnId, attachment });
              return [{ attachment, supersededSpeechId }, next] as const;
            }

            const speechId = yield* storeSegment(audioBytes);
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
            const next = new Map(entries);
            next.set(input.threadId, { turnId, attachment });
            return [{ attachment, supersededSpeechId }, next] as const;
          }),
        );
        if (staged_.supersededSpeechId !== undefined) {
          yield* removeAudioFile(staged_.supersededSpeechId);
        }
        return staged_.attachment;
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
