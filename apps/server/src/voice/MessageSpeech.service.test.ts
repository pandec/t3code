import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type MessageSpeechThreadState,
  type OrchestrationV2ConversationMessage,
  ProviderInstanceId,
} from "@t3tools/contracts";
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
import * as MessageSpeechScript from "../messageArtifacts/MessageSpeechScript.ts";
import { seedMessage, setMessageText } from "../messageArtifacts/testFixtures.ts";
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

/** Collects a thread's listening states as they stream, starting with the current one. */
const watchThread = Effect.fn("watchThread")(function* (
  stream: Stream.Stream<MessageSpeechThreadState>,
) {
  const states = yield* Queue.unbounded<MessageSpeechThreadState>();
  yield* stream.pipe(
    Stream.runForEach((state) => Queue.offer(states, state)),
    Effect.forkScoped,
  );
  return states;
});

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
      assert.deepEqual(yield* Queue.take(states), {
        threadId: message.threadId,
        recordings: [],
        pendingMessageIds: [],
      });

      const first = yield* Effect.forkChild(service.synthesize({ messageId: message.id }));
      assert.deepEqual((yield* Queue.take(states)).pendingMessageIds, [message.id]);
      yield* Deferred.await(entered);
      // A second client joins the running job instead of starting another.
      const second = yield* Effect.forkChild(service.synthesize({ messageId: message.id }));
      // The requester leaving does not cancel the server-owned job.
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(second);

      assert.equal(result.transcript, "Spoken: The **build** passed.");
      assert.equal(result.origin, "user");
      const finished = yield* Queue.take(states);
      assert.deepEqual(finished.pendingMessageIds, []);
      assert.deepEqual(finished.recordings, [result]);
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
      assert.deepEqual((yield* Queue.take(states)).recordings, []);

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
      assert.deepEqual((yield* Queue.take(states)).recordings, [result]);
    }),
  );

  it.effect("reports a typed failure and clears the pending state", () =>
    Effect.gen(function* () {
      const message = yield* seed("speech-quota", "Expensive answer.");
      const { service } = yield* makeSpeech(() =>
        Effect.fail(new TtsError({ reason: "quota_exceeded", detail: "out of credits" })),
      );
      const states = yield* watchThread(service.streamThread(message.threadId));
      yield* Queue.take(states);

      const failure = yield* Effect.flip(service.synthesize({ messageId: message.id }));

      assert.equal(failure.reason, "provider_quota_exceeded");
      // One state per change (job started, job ended); the last one counts.
      yield* Queue.take(states);
      assert.deepEqual(yield* Queue.take(states), {
        threadId: message.threadId,
        recordings: [],
        pendingMessageIds: [],
      });
    }),
  );
});
