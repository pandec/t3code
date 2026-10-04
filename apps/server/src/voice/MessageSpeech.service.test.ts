import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type MessageSpeechThreadState,
  type MessageSpeechThreadUpdate,
  type OrchestrationV2ConversationMessage,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import {
  MESSAGE_SUMMARY_RECIPE_HASH,
  messageArtifactTextHash,
} from "../messageArtifacts/identity.ts";
import * as MessageSpeechScript from "../messageArtifacts/MessageSpeechScript.ts";
import { seedMessage, setMessageText } from "../messageArtifacts/testFixtures.ts";
import { resolveSummaryProvenance } from "../messageArtifacts/threadSummaries.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { make } from "./MessageSpeech.ts";
import { TtsService } from "./TtsService.ts";
import { TtsError } from "./ttsTypes.ts";

const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const seed = (suffix: string, text: string) =>
  seedMessage({
    suffix,
    text,
    threadModelSelection: model,
    runModelSelection: model,
    worktreePath: null,
  });

/** Builds the service over fake text generation and speech; `synthesize` controls the vendor. */
const makeSpeech = Effect.fn("makeSpeech")(function* (
  synthesize: (text: string) => Effect.Effect<Uint8Array, TtsError>,
) {
  const ttsCalls = yield* Ref.make(0);
  const textGeneration = TextGeneration.of({
    generateCommitMessage: () => Effect.die("unused"),
    generatePrContent: () => Effect.die("unused"),
    generateBranchName: () => Effect.die("unused"),
    generateThreadTitle: () => Effect.die("unused"),
    generateMessageSummary: () => Effect.die("unused"),
    generateSpeechScript: (input) => Effect.succeed({ script: `Spoken: ${input.message}` }),
  });
  const scripts = yield* MessageSpeechScript.make.pipe(
    Effect.provideService(TextGeneration, textGeneration),
  );
  const tts = TtsService.of({
    environmentDefaults: {
      elevenlabs: { modelId: "eleven", voiceId: "voice" },
      openrouter: { modelId: "router", voiceId: "voice" },
    },
    isConfigured: () => Effect.succeed(true),
    configuredChanges: Stream.empty,
    status: Effect.die("unused"),
    catalog: () => Effect.die("unused"),
    configureOpenRouter: () => Effect.die("unused"),
    test: () => Effect.die("unused"),
    synthesize: (input) =>
      Ref.update(ttsCalls, (count) => count + 1).pipe(
        Effect.andThen(synthesize(input.text)),
        Effect.map((bytes) => ({
          bytes,
          mimeType: "audio/mpeg" as const,
          cost: { usd: null, billedCharacters: null },
        })),
      ),
  });
  const service = yield* make.pipe(
    Effect.provideService(MessageSpeechScript.MessageSpeechScript, scripts),
    Effect.provideService(TtsService, tts),
  );
  return { service, ttsCalls };
});

/** Collects a thread's listening updates as they stream, starting with the whole state. */
const watchThread = Effect.fn("watchThread")(function* (
  stream: Stream.Stream<MessageSpeechThreadUpdate>,
) {
  const updates = yield* Queue.unbounded<MessageSpeechThreadUpdate>();
  yield* stream.pipe(
    Stream.runForEach((update) => Queue.offer(updates, update)),
    Effect.forkScoped,
  );
  return updates;
});

type ThreadUpdates = Effect.Success<ReturnType<typeof watchThread>>;

const takeSnapshot = (updates: ThreadUpdates) =>
  Queue.take(updates).pipe(
    Effect.flatMap((update): Effect.Effect<MessageSpeechThreadState> =>
      update.type === "snapshot"
        ? Effect.succeed(update.state)
        : Effect.die(`expected a snapshot, got ${update.type}`),
    ),
  );

const speechFiles = Effect.gen(function* () {
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(attachmentsDir))) return [];
  return (yield* fileSystem.readDirectory(attachmentsDir)).filter((name) => name.endsWith(".mp3"));
});

const insertAgentRecording = (message: OrchestrationV2ConversationMessage) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO fork_message_speech (
        message_id, thread_id, speech_id, transcript, mime_type, size_bytes, duration_ms,
        source_text_hash, script_recipe_hash, voice_id, tts_model, origin, created_at
      ) VALUES (
        ${message.id}, ${message.threadId}, 'agent-speech', 'Agent said it.', 'audio/mpeg', 3,
        NULL, 'hash', NULL, 'voice', 'openrouter:router', 'agent', '2026-01-01T00:00:00.000Z'
      )
    `,
  );

const TestLayer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-message-speech-test-" }),
  ServerSettings.layerTest(),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestLayer)("message listening", (it) => {
  it.effect("runs one shared job, shows it pending to subscribers, then serves the recording", () =>
    Effect.gen(function* () {
      const message = yield* seed("speech-shared", "  The **build** passed.  ");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { service, ttsCalls } = yield* makeSpeech((text) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(new TextEncoder().encode(text)),
        ),
      );
      const states = yield* watchThread(service.streamThread(message.threadId));
      assert.deepEqual(yield* takeSnapshot(states), {
        threadId: message.threadId,
        recordings: [],
        pendingMessageIds: [],
        summaries: [],
      });

      const first = yield* Effect.forkChild(service.synthesize({ messageId: message.id }));
      // After the whole state, each change carries only the changed message.
      assert.deepEqual(yield* Queue.take(states), {
        type: "message",
        threadId: message.threadId,
        messageId: message.id,
        pending: true,
      });
      yield* Deferred.await(entered);
      // A second client joins the running job instead of starting another.
      const second = yield* Effect.forkChild(service.synthesize({ messageId: message.id }));
      // The requester leaving does not cancel the server-owned job.
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(second);

      assert.equal(result.transcript, "Spoken: The **build** passed.");
      assert.equal(result.origin, "user");
      assert.deepEqual(yield* Queue.take(states), {
        type: "message",
        threadId: message.threadId,
        messageId: message.id,
        recording: result,
        pending: false,
      });
      assert.deepEqual(yield* speechFiles, [`${result.speechId}.mp3`]);

      // Asking again reuses the stored recording.
      assert.deepEqual(yield* service.synthesize({ messageId: message.id }), result);
      assert.equal(yield* Ref.get(ttsCalls), 1);
    }),
  );

  it.effect("drops audio made from text that changed meanwhile and hides stale recordings", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const message = yield* seed("speech-stale", "First answer.");
      const editDuringSynthesis = yield* Ref.make(false);
      const { service } = yield* makeSpeech((text) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(editDuringSynthesis, false)) {
            yield* setMessageText(message, "Third answer.").pipe(
              Effect.provideService(ProjectionStore.ProjectionStoreV2, store),
              Effect.orDie,
            );
          }
          return new TextEncoder().encode(text);
        }),
      );
      const filesBefore = yield* speechFiles;
      const recorded = yield* service.synthesize({ messageId: message.id });

      yield* setMessageText(message, "Second answer.");
      const states = yield* watchThread(service.streamThread(message.threadId));
      assert.deepEqual((yield* takeSnapshot(states)).recordings, []);

      yield* Ref.set(editDuringSynthesis, true);
      const stale = yield* Effect.flip(service.synthesize({ messageId: message.id }));
      assert.equal(stale.reason, "message_unavailable");
      // Only the first recording's file remains; the stale one was removed.
      assert.deepEqual(
        (yield* speechFiles).filter((name) => !filesBefore.includes(name)),
        [`${recorded.speechId}.mp3`],
      );
    }),
  );

  it.effect("never replaces the agent's own recording", () =>
    Effect.gen(function* () {
      const message = yield* seed("speech-agent", "Agent answer.");
      yield* insertAgentRecording(message);
      const { service, ttsCalls } = yield* makeSpeech((text) =>
        Effect.succeed(new TextEncoder().encode(text)),
      );

      const result = yield* service.synthesize({ messageId: message.id });

      assert.equal(result.origin, "agent");
      assert.equal(result.speechId, "agent-speech");
      assert.equal(yield* Ref.get(ttsCalls), 0);
      const states = yield* watchThread(service.streamThread(message.threadId));
      assert.deepEqual((yield* takeSnapshot(states)).recordings, [result]);
    }),
  );

  it.effect("reports a typed failure and clears the pending state", () =>
    Effect.gen(function* () {
      const message = yield* seed("speech-quota", "Expensive answer.");
      const { service } = yield* makeSpeech(() =>
        Effect.fail(new TtsError({ reason: "quota_exceeded", detail: "out of credits" })),
      );
      const states = yield* watchThread(service.streamThread(message.threadId));
      yield* takeSnapshot(states);

      const failure = yield* Effect.flip(service.synthesize({ messageId: message.id }));

      assert.equal(failure.reason, "provider_quota_exceeded");
      // One update per change (job started, job ended); the last one counts.
      yield* Queue.take(states);
      assert.deepEqual(yield* Queue.take(states), {
        type: "message",
        threadId: message.threadId,
        messageId: message.id,
        pending: false,
      });
    }),
  );

  it.effect("purges a deleted thread's recordings, scripts and summaries, files included", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const deleted = yield* seed("speech-deleted", "Deleted answer.");
      const live = yield* seed("speech-live", "Live answer.");
      const { service } = yield* makeSpeech((text) =>
        Effect.succeed(new TextEncoder().encode(text)),
      );
      const deletedRecording = yield* service.synthesize({ messageId: deleted.id });
      const liveRecording = yield* service.synthesize({ messageId: live.id });
      for (const message of [deleted, live]) {
        yield* sql`
          INSERT INTO fork_message_summaries (
            message_id, thread_id, summary, source_text_hash, recipe_hash,
            model_selection_json, model_selection_hash, created_at
          ) VALUES (
            ${message.id}, ${message.threadId}, 'Summary.', 'hash', 'recipe', '{}', 'model',
            '2026-01-01T00:00:00.000Z'
          )
        `;
      }
      const thread = (yield* store.getThreadProjection(deleted.threadId)).thread;
      const now = yield* DateTime.now;
      yield* store.apply({
        id: EventId.make("event:speech-deleted:deleted"),
        type: "thread.deleted",
        threadId: deleted.threadId,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: now,
        payload: { ...thread, deletedAt: now, updatedAt: now },
      });
      // A deleted thread shows nothing even before the purge ran.
      const deletedStates = yield* watchThread(service.streamThread(deleted.threadId));
      assert.deepEqual((yield* takeSnapshot(deletedStates)).recordings, []);

      yield* service.purgeDeletedThreads;

      const rowCounts = (threadId: string) =>
        Effect.forEach(
          ["fork_message_speech", "fork_message_speech_scripts", "fork_message_summaries"],
          (table) =>
            sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM ${sql(table)} WHERE thread_id = ${threadId}
            `.pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
        );
      assert.deepEqual(yield* rowCounts(deleted.threadId), [0, 0, 0]);
      assert.deepEqual(yield* rowCounts(live.threadId), [1, 1, 1]);
      const files = yield* speechFiles;
      assert.notInclude(files, `${deletedRecording.speechId}.mp3`);
      assert.include(files, `${liveRecording.speechId}.mp3`);
      const liveStates = yield* watchThread(service.streamThread(live.threadId));
      assert.deepEqual((yield* takeSnapshot(liveStates)).recordings, [liveRecording]);
    }),
  );

  it.effect("shows a fork the artifacts of the messages it inherited, live", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const recorded = yield* seed("speech-fork-source", "Inherited answer.");
      const preparing: OrchestrationV2ConversationMessage = {
        ...recorded,
        id: MessageId.make("message:speech-fork-source:2"),
      };
      yield* setMessageText(preparing, "Second inherited answer.");
      yield* insertAgentRecording(recorded);
      const provenance = yield* resolveSummaryProvenance(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        { runModelSelection: JSON.stringify(model), threadModelSelection: null },
        null,
      );
      assert.isNotNull(provenance);
      yield* sql`
        INSERT INTO fork_message_summaries (
          message_id, thread_id, summary, source_text_hash, recipe_hash,
          model_selection_json, model_selection_hash, created_at
        ) VALUES (
          ${recorded.id}, ${recorded.threadId}, 'Inherited summary.',
          ${messageArtifactTextHash("Inherited answer.")}, ${MESSAGE_SUMMARY_RECIPE_HASH},
          ${provenance?.modelSelectionJson ?? ""}, ${provenance?.modelSelectionHash ?? ""},
          '2026-01-01T00:00:00.000Z'
        )
      `;
      const source = (yield* store.getThreadProjection(recorded.threadId)).thread;
      const forkId = ThreadId.make("thread:speech-fork");
      yield* store.apply({
        id: EventId.make("event:speech-fork:created"),
        type: "thread.created",
        threadId: forkId,
        providerInstanceId: source.providerInstanceId,
        occurredAt: yield* DateTime.now,
        payload: {
          ...source,
          id: forkId,
          lineage: {
            parentThreadId: source.id,
            relationshipToParent: "fork",
            rootThreadId: source.lineage.rootThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: source.id,
            runId: recorded.runId ?? RunId.make("run:speech-fork-source"),
          },
        },
      });
      const release = yield* Deferred.make<void>();
      const { service } = yield* makeSpeech((text) =>
        Deferred.await(release).pipe(Effect.as(new TextEncoder().encode(text))),
      );

      const updates = yield* watchThread(service.streamThread(forkId));
      const snapshot = yield* takeSnapshot(updates);
      assert.equal(snapshot.threadId, forkId);
      assert.deepEqual(
        snapshot.recordings.map((recording) => recording.messageId),
        [recorded.id],
      );
      assert.deepEqual(
        snapshot.summaries.map((summary) => summary.summary),
        ["Inherited summary."],
      );

      // A job on the source thread reaches the fork's subscribers.
      const job = yield* Effect.forkChild(service.synthesize({ messageId: preparing.id }));
      assert.deepEqual(yield* Queue.take(updates), {
        type: "message",
        threadId: forkId,
        messageId: preparing.id,
        pending: true,
      });
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(job);
      assert.deepEqual(yield* Queue.take(updates), {
        type: "message",
        threadId: forkId,
        messageId: preparing.id,
        recording: result,
        pending: false,
      });
    }),
  );
});
