import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as MessageSpeechScript from "../messageArtifacts/MessageSpeechScript.ts";
import { seedMessage } from "../messageArtifacts/testFixtures.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as AgentVoiceReply from "./AgentVoiceReply.ts";
import * as MessageSpeech from "./MessageSpeech.ts";
import { TtsService } from "./TtsService.ts";

const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

/** A thread whose run is running `attempt`; returns the ids finalization needs. */
const seedRunningThread = Effect.fn("seedRunningThread")(function* (suffix: string) {
  // Projects the thread and its run; the seeded user message is incidental.
  yield* seedMessage({
    suffix,
    text: "Please answer out loud.",
    threadModelSelection: model,
    runModelSelection: model,
    worktreePath: null,
    role: "user",
  });
  const threadId = ThreadId.make(`thread:${suffix}`);
  const run = {
    id: RunId.make(`run:${suffix}`),
    threadId,
    ordinal: 1,
    providerInstanceId: model.instanceId,
    modelSelection: model,
    providerThreadId: null,
    userMessageId: MessageId.make(`user-message:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    activeAttemptId: null,
    status: "running",
    requestedAt: yield* DateTime.now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
  const rootNode = {
    id: run.rootNodeId,
    providerTurnId: null,
  } as OrchestrationV2ExecutionNode;
  return { threadId, run, rootNode, suffix };
});

type Seeded = Effect.Success<ReturnType<typeof seedRunningThread>>;

let eventCounter = 0;
const nextEventId = () => EventId.make(`event:agent-voice:${(eventCounter += 1)}`);

/** Re-projects the run as running `attemptId` (null: not running at all). */
const setRunningAttempt = (seeded: Seeded, attemptId: string | null) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* store.apply({
      id: nextEventId(),
      type: "run.updated",
      threadId: seeded.threadId,
      runId: seeded.run.id,
      occurredAt: yield* DateTime.now,
      payload: {
        ...seeded.run,
        status: attemptId === null ? "waiting" : "running",
        activeAttemptId: attemptId === null ? null : RunAttemptId.make(attemptId),
      },
    });
  });

/** Projects a finished assistant reply of the run, as a provider would. */
const addAssistantReply = (seeded: Seeded, ordinal: number, text: string) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const messageId = MessageId.make(`assistant:${seeded.suffix}:${ordinal}`);
    yield* store.apply({
      id: nextEventId(),
      type: "message.updated",
      threadId: seeded.threadId,
      runId: seeded.run.id,
      occurredAt: now,
      payload: {
        createdBy: "agent",
        creationSource: "provider",
        id: messageId,
        threadId: seeded.threadId,
        runId: seeded.run.id,
        nodeId: seeded.run.rootNodeId,
        role: "assistant",
        text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* store.apply({
      id: nextEventId(),
      type: "turn-item.updated",
      threadId: seeded.threadId,
      runId: seeded.run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`item:${seeded.suffix}:${ordinal}`),
        threadId: seeded.threadId,
        runId: seeded.run.id,
        nodeId: seeded.run.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "assistant_message",
        messageId,
        text,
        streaming: false,
      },
    });
    return messageId;
  });

/** Builds both services over fake speech; `onSynthesize` runs inside each vendor call. */
const makeServices = Effect.fn("makeServices")(function* (
  onSynthesize: Effect.Effect<void> = Effect.void,
) {
  const textGeneration = TextGeneration.of({
    generateCommitMessage: () => Effect.die("unused"),
    generatePrContent: () => Effect.die("unused"),
    generateBranchName: () => Effect.die("unused"),
    generateThreadTitle: () => Effect.die("unused"),
    generateMessageSummary: () => Effect.die("unused"),
    generateSpeechScript: () => Effect.die("unused"),
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
      onSynthesize.pipe(
        Effect.as({
          bytes: new TextEncoder().encode(input.text),
          mimeType: "audio/mpeg" as const,
          cost: { usd: null, billedCharacters: null },
        }),
      ),
  });
  const speech = yield* MessageSpeech.make.pipe(
    Effect.provideService(MessageSpeechScript.MessageSpeechScript, scripts),
    Effect.provideService(TtsService, tts),
  );
  const voice = yield* AgentVoiceReply.make.pipe(
    Effect.provideService(MessageSpeech.MessageSpeech, speech),
    Effect.provideService(TtsService, tts),
  );
  return { speech, voice };
});

const speechFiles = Effect.gen(function* () {
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(attachmentsDir))) return [];
  return (yield* fileSystem.readDirectory(attachmentsDir)).filter((name) => name.endsWith(".mp3"));
});

/** Speech files of one thread (attachment ids start with the thread segment). */
const threadSpeechFiles = (suffix: string) =>
  speechFiles.pipe(
    Effect.map((names) => names.filter((name) => name.startsWith(`thread-${suffix}-`))),
  );

const currentRecordings = (speech: MessageSpeech.MessageSpeechShape, threadId: ThreadId) =>
  Effect.gen(function* () {
    const states =
      yield* Queue.unbounded<
        Stream.Success<ReturnType<MessageSpeech.MessageSpeechShape["streamThread"]>>
      >();
    yield* speech.streamThread(threadId).pipe(
      Stream.take(1),
      Stream.runForEach((state) => Queue.offer(states, state)),
    );
    return (yield* Queue.take(states)).recordings;
  });

const finalize = (
  voice: AgentVoiceReply.AgentVoiceReplyShape,
  seeded: Seeded,
  attemptId: string,
  completed: boolean,
) =>
  Effect.gen(function* () {
    return yield* voice.finalizeAttempt({
      run: seeded.run,
      attemptId: RunAttemptId.make(attemptId),
      rootNode: seeded.rootNode,
      providerThreadId: ProviderThreadId.make(`provider-thread:${seeded.suffix}`),
      completed,
      completedAt: yield* DateTime.now,
      allocateEventId: () => Effect.sync(nextEventId),
    });
  });

const TestLayer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-voice-reply-test-" }),
  ServerSettings.layerTest(),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestLayer)("agent voice replies", (it) => {
  it.effect("attaches the attempt's segments to the run's last written reply", () =>
    Effect.gen(function* () {
      const seeded = yield* seedRunningThread("voice-final");
      yield* setRunningAttempt(seeded, "attempt-1");
      const { speech, voice } = yield* makeServices();

      yield* voice.stage({ threadId: seeded.threadId, script: "  Hello there.  " });
      const second = yield* voice.stage({ threadId: seeded.threadId, script: "Second part." });
      assert.equal(second.transcriptChars, "Hello there.\n\nSecond part.".length);
      // Appending replaced the first segment's file with the merged one.
      assert.lengthOf(yield* threadSpeechFiles("voice-final"), 1);

      yield* addAssistantReply(seeded, 1, "Working on it.");
      const finalMessageId = yield* addAssistantReply(seeded, 2, "Here is the answer.");
      yield* setRunningAttempt(seeded, null);
      const finalization = yield* finalize(voice, seeded, "attempt-1", true);
      assert.deepEqual(finalization.events, []);
      yield* finalization.committed;

      const recordings = yield* currentRecordings(speech, seeded.threadId);
      assert.lengthOf(recordings, 1);
      assert.equal(recordings[0]?.messageId, finalMessageId);
      assert.equal(recordings[0]?.origin, "agent");
      assert.equal(recordings[0]?.transcript, "Hello there.\n\nSecond part.");
      assert.deepEqual(yield* threadSpeechFiles("voice-final"), [`${recordings[0]?.speechId}.mp3`]);
    }),
  );

  it.effect("publishes the transcript as the written reply of a voice-only run", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const seeded = yield* seedRunningThread("voice-only");
      yield* setRunningAttempt(seeded, "attempt-1");
      const { speech, voice } = yield* makeServices();
      yield* voice.stage({ threadId: seeded.threadId, script: "Only spoken." });

      const finalization = yield* finalize(voice, seeded, "attempt-1", true);
      assert.deepEqual(
        finalization.events.map((event) => event.type),
        ["message.updated", "turn-item.updated"],
      );
      for (const event of finalization.events) yield* store.apply(event);
      yield* finalization.committed;

      const projection = yield* store.getThreadProjection(seeded.threadId);
      const reply = projection.messages.find((message) => message.role === "assistant");
      assert.equal(reply?.text, "Only spoken.");
      assert.equal(reply?.runId, seeded.run.id);
      const recordings = yield* currentRecordings(speech, seeded.threadId);
      assert.equal(recordings[0]?.messageId, reply?.id);
      assert.equal(recordings[0]?.origin, "agent");
    }),
  );

  it.effect("throws the recording away when its attempt does not complete normally", () =>
    Effect.gen(function* () {
      const seeded = yield* seedRunningThread("voice-stopped");
      yield* setRunningAttempt(seeded, "attempt-1");
      const { speech, voice } = yield* makeServices();
      yield* voice.stage({ threadId: seeded.threadId, script: "Never heard." });
      yield* addAssistantReply(seeded, 1, "Partial answer.");

      const finalization = yield* finalize(voice, seeded, "attempt-1", false);

      assert.deepEqual(finalization.events, []);
      assert.deepEqual(yield* threadSpeechFiles("voice-stopped"), []);
      assert.deepEqual(yield* currentRecordings(speech, seeded.threadId), []);
      // Taken once: a later completion of the same attempt finds nothing.
      assert.deepEqual((yield* finalize(voice, seeded, "attempt-1", true)).events, []);
    }),
  );

  it.effect("a newer attempt replaces what an older one staged", () =>
    Effect.gen(function* () {
      const seeded = yield* seedRunningThread("voice-steered");
      yield* setRunningAttempt(seeded, "attempt-1");
      const { voice } = yield* makeServices();
      yield* voice.stage({ threadId: seeded.threadId, script: "Old answer." });

      yield* setRunningAttempt(seeded, "attempt-2");
      const result = yield* voice.stage({ threadId: seeded.threadId, script: "New answer." });

      assert.equal(result.transcriptChars, "New answer.".length);
      assert.lengthOf(yield* threadSpeechFiles("voice-steered"), 1);
      assert.deepEqual((yield* finalize(voice, seeded, "attempt-1", true)).events, []);
      assert.lengthOf((yield* finalize(voice, seeded, "attempt-2", true)).events, 2);
    }),
  );

  it.effect("refuses to stage for an attempt that was already finalized", () =>
    Effect.gen(function* () {
      const seeded = yield* seedRunningThread("voice-closed");
      // The projection still shows the attempt running, as it does while
      // finalization races a stage call that is synthesizing.
      yield* setRunningAttempt(seeded, "attempt-1");
      const { voice } = yield* makeServices();
      yield* finalize(voice, seeded, "attempt-1", false);

      const late = yield* Effect.flip(
        voice.stage({ threadId: seeded.threadId, script: "Too late." }),
      );

      assert.equal(late.reason, "turn_unavailable");
      assert.deepEqual(yield* threadSpeechFiles("voice-closed"), []);
      assert.deepEqual((yield* finalize(voice, seeded, "attempt-1", true)).events, []);
    }),
  );

  it.effect("refuses to stage without a running attempt or when it changes mid-synthesis", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const seeded = yield* seedRunningThread("voice-refused");
      const steerDuringSynthesis = yield* Ref.make(false);
      const { voice } = yield* makeServices(
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(steerDuringSynthesis, false)) {
            yield* setRunningAttempt(seeded, "attempt-2").pipe(
              Effect.provideService(ProjectionStore.ProjectionStoreV2, store),
              Effect.orDie,
            );
          }
        }),
      );

      // The seeded run has no active attempt yet.
      yield* setRunningAttempt(seeded, null);
      const idle = yield* Effect.flip(voice.stage({ threadId: seeded.threadId, script: "Hi." }));
      assert.equal(idle.reason, "turn_unavailable");

      yield* setRunningAttempt(seeded, "attempt-1");
      yield* Ref.set(steerDuringSynthesis, true);
      const steered = yield* Effect.flip(voice.stage({ threadId: seeded.threadId, script: "Hi." }));
      assert.equal(steered.reason, "turn_unavailable");
      assert.deepEqual(yield* threadSpeechFiles("voice-refused"), []);
    }),
  );
});
