import {
  AGENT_VOICE_REPLY_MAX_SCRIPT_CHARS,
  AgentVoiceReplyError,
  type AgentVoiceReplyResult,
  type EventId,
  MESSAGE_SPEECH_MAX_SCRIPT_CHARS,
  MessageId,
  type NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type ProviderThreadId,
  type RunAttemptId,
  type RunId,
  type SpeechAudioMimeType,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { type AgentSpeechRecording, MessageSpeech } from "./MessageSpeech.ts";
import { appendSpeechAudio } from "./speechChunks.ts";
import { estimateSpeechDurationMs } from "./speechDuration.ts";
import { getTtsCharacterLimit, resolveAgentReplyTtsProfile } from "./ttsProfile.ts";
import { TtsService } from "./TtsService.ts";
import { speechFailureReasonFor, speechFileExtension } from "./ttsTypes.ts";

/** The run attempt a staged recording belongs to: the v2 counterpart of a provider turn. */
interface RunAttemptOwner {
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
}

interface StagedAgentVoiceReply extends RunAttemptOwner {
  readonly recording: AgentSpeechRecording;
}

/**
 * Staged recordings per thread, plus each thread's recently finalized
 * attempts: a stage call still running when its attempt was finalized must
 * not park (or replace) anything afterwards.
 */
interface StagingState {
  readonly entries: ReadonlyMap<ThreadId, StagedAgentVoiceReply>;
  readonly closed: ReadonlyMap<ThreadId, ReadonlyArray<string>>;
}

// Finalization closes attempts in order, so only the last few can still race a stage call.
const MAX_CLOSED_ATTEMPTS_PER_THREAD = 8;

const attemptKey = (owner: RunAttemptOwner) => `${owner.runId}:${owner.attemptId}`;

/**
 * What run finalization does with the attempt's staged recording. `events`
 * go into the run's final event batch; exactly one of `committed` (the batch
 * was written) or `abandoned` (it was not) must run afterwards.
 */
export interface AgentVoiceReplyFinalization {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly committed: Effect.Effect<void>;
  readonly abandoned: Effect.Effect<void>;
}

const NO_FINALIZATION: AgentVoiceReplyFinalization = {
  events: [],
  committed: Effect.void,
  abandoned: Effect.void,
};

export interface AgentVoiceReplyShape {
  /** Whether the agent-reply profile's provider currently holds a key. Read per call. */
  readonly available: Effect.Effect<boolean>;
  /**
   * Synthesizes `script` and parks it for the thread's running attempt. A
   * second call in the same attempt appends a segment; a call from a newer
   * attempt replaces whatever an older one left.
   */
  readonly stage: (input: {
    readonly threadId: ThreadId;
    readonly script: string;
  }) => Effect.Effect<AgentVoiceReplyResult, AgentVoiceReplyError>;
  /**
   * Called once when a run attempt ends. Only a normally completed attempt
   * publishes its recording, on the run's last assistant message; any other
   * ending (failure, Stop, steer) throws the recording away, since it no
   * longer matches what actually happened.
   */
  readonly finalizeAttempt: <E>(input: {
    readonly run: OrchestrationV2Run;
    readonly attemptId: RunAttemptId;
    readonly rootNode: OrchestrationV2ExecutionNode;
    readonly providerThreadId: ProviderThreadId;
    readonly completed: boolean;
    readonly completedAt: DateTime.Utc;
    readonly allocateEventId: () => Effect.Effect<EventId, E>;
  }) => Effect.Effect<AgentVoiceReplyFinalization, E>;
}

/**
 * Agent voice replies. The `voice_reply` MCP tool synthesizes a recording
 * mid-run and parks it here, bound to the run attempt that was running. When
 * that attempt completes normally, run finalization attaches it to the run's
 * last assistant message as an agent recording (`MessageSpeech`). A run that
 * produced no written reply gets the transcript as its message text, in the
 * same event batch, so the recording always has a durable, searchable home.
 *
 * Staged recordings live in memory; their audio is written at stage time so
 * attaching stays metadata-only. A server restart drops them with their run.
 */
export class AgentVoiceReply extends Context.Service<AgentVoiceReply, AgentVoiceReplyShape>()(
  "t3/voice/AgentVoiceReply",
) {}

export const make = Effect.gen(function* () {
  const tts = yield* TtsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const messageSpeech = yield* MessageSpeech;
  const projectionStore = yield* ProjectionStoreV2;
  const staged = yield* SynchronizedRef.make<StagingState>({
    entries: new Map(),
    closed: new Map(),
  });

  const resolveSpeechPath = (speechId: string, mimeType: SpeechAudioMimeType) =>
    resolveAttachmentRelativePath({
      attachmentsDir: serverConfig.attachmentsDir,
      relativePath: `${speechId}${speechFileExtension(mimeType)}`,
    });

  const removeAudioFile = (recording: Pick<AgentSpeechRecording, "speechId" | "mimeType">) => {
    const path = resolveSpeechPath(recording.speechId, recording.mimeType);
    return path ? fileSystem.remove(path, { force: true }).pipe(Effect.ignore) : Effect.void;
  };

  /**
   * The thread's running attempt. Fails closed: without one, staging refuses,
   * because a recording bound to a guessed attempt can attach to the wrong run.
   */
  const resolveRunningAttempt = (threadId: ThreadId) =>
    projectionStore.getRunningTurnContext(threadId).pipe(
      Effect.map(({ run }): RunAttemptOwner | null =>
        run === undefined || run.activeAttemptId === null
          ? null
          : { runId: run.id, attemptId: run.activeAttemptId },
      ),
      Effect.catch((error) =>
        error._tag === "ProjectionStoreThreadNotFoundError"
          ? Effect.succeed(null)
          : Effect.fail(new AgentVoiceReplyError({ reason: "storage_failed" })),
      ),
    );

  const sameAttempt = (left: RunAttemptOwner, right: RunAttemptOwner) =>
    left.runId === right.runId && left.attemptId === right.attemptId;

  // Atomic take: the entry leaves the map before anyone uses it, so a
  // concurrent re-stage can neither be consumed by mistake nor delete the file
  // the taker is about to reference. The attempt is closed in the same update,
  // whether or not it had staged anything.
  const takeForAttempt = (threadId: ThreadId, owner: RunAttemptOwner) =>
    SynchronizedRef.modify(staged, (state) => {
      const closed = new Map(state.closed);
      closed.set(
        threadId,
        [...(state.closed.get(threadId) ?? []), attemptKey(owner)].slice(
          -MAX_CLOSED_ATTEMPTS_PER_THREAD,
        ),
      );
      const current = state.entries.get(threadId);
      if (!current || !sameAttempt(current, owner)) {
        return [undefined, { entries: state.entries, closed }] as const;
      }
      const entries = new Map(state.entries);
      entries.delete(threadId);
      return [current, { entries, closed }] as const;
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
      // Vendor-qualified so a stored recording names where it came from.
      const ttsModel = `${profile.provider}:${profile.modelId}`;

      const script = input.script.trim();
      if (script.length === 0) {
        return yield* new AgentVoiceReplyError({ reason: "empty_script" });
      }
      if (
        script.length > Math.min(AGENT_VOICE_REPLY_MAX_SCRIPT_CHARS, getTtsCharacterLimit(profile))
      ) {
        return yield* new AgentVoiceReplyError({ reason: "script_too_long" });
      }

      const owner = yield* resolveRunningAttempt(input.threadId);
      if (owner === null) {
        return yield* new AgentVoiceReplyError({ reason: "turn_unavailable" });
      }
      const { bytes: audioBytes, mimeType } = yield* tts
        .synthesize({ profile, text: script })
        .pipe(
          Effect.mapError(
            (error) => new AgentVoiceReplyError({ reason: speechFailureReasonFor(error) }),
          ),
        );

      // Synthesis is slow. If the run was steered, stopped or finished
      // meanwhile, this recording belongs to an attempt that will never
      // complete normally: refuse rather than stage it.
      const ownerAfterSynthesis = yield* resolveRunningAttempt(input.threadId);
      if (ownerAfterSynthesis === null || !sameAttempt(owner, ownerAfterSynthesis)) {
        return yield* new AgentVoiceReplyError({ reason: "turn_unavailable" });
      }

      yield* fileSystem
        .makeDirectory(serverConfig.attachmentsDir, { recursive: true })
        .pipe(Effect.mapError(() => new AgentVoiceReplyError({ reason: "storage_failed" })));

      const storeAudio = (bytes: Uint8Array) =>
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

      // The read-merge-write holds the map's lock, which taking an entry also
      // takes, so finalization sees either the fully merged entry or none.
      // The superseded file is deleted only after the new entry is in place:
      // an interrupt can at worst orphan a file, never leave the map pointing
      // at a deleted one.
      const result = yield* SynchronizedRef.modifyEffect(staged, (state) =>
        Effect.gen(function* () {
          // Finalized while synthesizing or waiting for the lock: nothing is
          // written yet, so refusing leaves nothing behind.
          if (state.closed.get(input.threadId)?.includes(attemptKey(owner))) {
            return yield* new AgentVoiceReplyError({ reason: "turn_unavailable" });
          }
          const previous = state.entries.get(input.threadId);
          const appending = previous !== undefined && sameAttempt(previous, owner);
          let recording: AgentSpeechRecording;
          if (appending) {
            // Segments play in call order as one recording. Voice, model and
            // creation time stay those of the first segment.
            const transcript = `${previous.recording.transcript}\n\n${script}`;
            if (transcript.length > MESSAGE_SPEECH_MAX_SCRIPT_CHARS) {
              return yield* new AgentVoiceReplyError({ reason: "script_too_long" });
            }
            const previousPath = resolveSpeechPath(
              previous.recording.speechId,
              previous.recording.mimeType,
            );
            const previousBytes =
              previousPath === null
                ? null
                : yield* fileSystem.readFile(previousPath).pipe(Effect.orElseSucceed(() => null));
            const mergedBytes =
              previousBytes !== null && previous.recording.mimeType === mimeType
                ? appendSpeechAudio(previousBytes, audioBytes, mimeType)
                : null;
            if (mergedBytes === null) {
              return yield* new AgentVoiceReplyError({ reason: "storage_failed" });
            }
            // A fresh id, so a failed write leaves the staged recording intact.
            recording = {
              ...previous.recording,
              speechId: yield* storeAudio(mergedBytes),
              transcript,
              sizeBytes: mergedBytes.byteLength,
              durationMs: estimateSpeechDurationMs(mergedBytes, mimeType),
            };
          } else {
            recording = {
              speechId: yield* storeAudio(audioBytes),
              transcript: script,
              mimeType,
              sizeBytes: audioBytes.byteLength,
              durationMs: estimateSpeechDurationMs(audioBytes, mimeType),
              voiceId: profile.voiceId,
              ttsModel,
              createdAt: DateTime.formatIso(yield* DateTime.now),
            };
          }
          const entries = new Map(state.entries);
          entries.set(input.threadId, { ...owner, recording });
          return [
            { recording, superseded: previous?.recording },
            { entries, closed: state.closed },
          ] as const;
        }),
      );
      if (result.superseded !== undefined) {
        yield* removeAudioFile(result.superseded);
      }
      return {
        status: "staged" as const,
        transcriptChars: result.recording.transcript.length,
        audioSizeBytes: result.recording.sizeBytes,
      };
    },
  );

  /**
   * The attempt's last written assistant reply on the thread itself (not a
   * subagent's). Scoped to the attempt's root node, so a reply an interrupted
   * earlier attempt of the same run wrote never receives this recording.
   * Replies usually sit on their own child node of that root.
   */
  const findFinalAssistantMessageId = (threadId: ThreadId, runId: RunId, rootNodeId: NodeId) =>
    sql<{ readonly messageId: string }>`
      SELECT json_extract(item.payload_json, '$.messageId') AS "messageId"
      FROM orchestration_v2_projection_turn_items AS item
      LEFT JOIN orchestration_v2_projection_nodes AS node
        ON node.node_id = item.node_id
      WHERE item.thread_id = ${threadId}
        AND item.run_id = ${runId}
        AND (item.node_id = ${rootNodeId} OR node.root_node_id = ${rootNodeId})
        AND item.type = 'assistant_message'
        AND item.parent_item_id IS NULL
        AND TRIM(COALESCE(json_extract(item.payload_json, '$.text'), '')) <> ''
      ORDER BY item.ordinal DESC, item.turn_item_id DESC
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]?.messageId));

  const publish = (threadId: ThreadId, messageId: MessageId, recording: AgentSpeechRecording) =>
    messageSpeech.attachAgentRecording({ threadId, messageId, recording }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("agent voice reply could not be attached", {
          threadId,
          messageId,
          reason: error.reason,
        }).pipe(Effect.andThen(removeAudioFile(recording))),
      ),
    );

  const finalizeAttempt: AgentVoiceReplyShape["finalizeAttempt"] = (input) =>
    Effect.gen(function* () {
      const threadId = input.run.threadId;
      const entry = yield* takeForAttempt(threadId, {
        runId: input.run.id,
        attemptId: input.attemptId,
      });
      if (entry === undefined) return NO_FINALIZATION;
      const discard = removeAudioFile(entry.recording);
      if (!input.completed) {
        yield* discard;
        return NO_FINALIZATION;
      }
      // Fails closed: an unreadable projection must never be taken for "the
      // run wrote nothing", which would add a duplicate voice-only reply.
      const existing = yield* findFinalAssistantMessageId(
        threadId,
        input.run.id,
        input.rootNode.id,
      ).pipe(
        Effect.map((messageId) => ({ ok: true as const, messageId })),
        Effect.catch((error) =>
          Effect.logWarning("agent voice reply dropped: final reply lookup failed", {
            threadId,
            runId: input.run.id,
            error,
          }).pipe(Effect.as({ ok: false as const })),
        ),
      );
      if (!existing.ok) {
        yield* discard;
        return NO_FINALIZATION;
      }
      if (existing.messageId !== undefined) {
        return {
          events: [],
          committed: publish(threadId, MessageId.make(existing.messageId), entry.recording),
          abandoned: discard,
        };
      }

      // A voice-only run: the transcript becomes the written reply.
      const messageId = MessageId.make(`assistant:voice-reply:${input.attemptId}`);
      const at = input.completedAt;
      const base = {
        threadId,
        runId: input.run.id,
        nodeId: input.rootNode.id,
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: at,
      };
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        {
          ...base,
          id: yield* input.allocateEventId(),
          type: "message.updated",
          payload: {
            createdBy: "agent",
            creationSource: "provider",
            id: messageId,
            threadId,
            runId: input.run.id,
            nodeId: input.rootNode.id,
            role: "assistant",
            text: entry.recording.transcript,
            attachments: [],
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
        {
          ...base,
          id: yield* input.allocateEventId(),
          type: "turn-item.updated",
          payload: {
            id: TurnItemId.make(`turn-item:voice-reply:${input.attemptId}`),
            threadId,
            runId: input.run.id,
            nodeId: input.rootNode.id,
            providerThreadId: input.providerThreadId,
            providerTurnId: input.rootNode.providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            // Placeholder: the event sink assigns the run's next position.
            ordinal: 0,
            status: "completed",
            title: null,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
            type: "assistant_message",
            messageId,
            text: entry.recording.transcript,
            streaming: false,
          },
        },
      ];
      return {
        events,
        committed: publish(threadId, messageId, entry.recording),
        abandoned: discard,
      };
    });

  const available = serverSettings.getSettings.pipe(
    Effect.flatMap((settings) =>
      tts.isConfigured(
        resolveAgentReplyTtsProfile(settings.voice, tts.environmentDefaults).provider,
      ),
    ),
    Effect.orElseSucceed(() => false),
  );

  return AgentVoiceReply.of({ available, stage, finalizeAttempt });
});

export const layer = Layer.effect(AgentVoiceReply, make);
