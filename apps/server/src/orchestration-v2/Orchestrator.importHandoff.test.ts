import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { messageEvents } from "../project/AgentSessionImporter.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for a deferred run"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistence.layerMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "import-handoff" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

/** Creates a runless imported thread, optionally backed by a native session, then sends a message. */
const dispatchToImportedThread = Effect.fn(function* (name: string, nativeBacked: boolean) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId: ProjectId.make("project:import-handoff"),
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const now = yield* DateTime.now;
  const { thread } = yield* projections.getThreadProjection(threadId);
  yield* projections.apply({
    id: EventId.make(`import:${name}`),
    type: "thread.metadata-updated",
    threadId,
    occurredAt: now,
    payload: { ...thread, historyOrigin: "v1_import" },
  });
  const messages = [
    { role: "user" as const, text: "Remember violet.", createdAt: "2026-09-01T10:00:00.000Z" },
    { role: "assistant" as const, text: "Violet.", createdAt: "2026-09-01T10:01:00.000Z" },
  ];
  for (const [index, message] of messages.entries()) {
    for (const event of messageEvents({ threadId, index, message })) {
      yield* projections.apply(event);
    }
  }
  if (nativeBacked) {
    yield* projections.apply({
      id: EventId.make(`provider-thread:${name}`),
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make(`provider-thread:${name}`),
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: `native:${name}`, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`send:${name}`),
    threadId,
    messageId: MessageId.make(`message:${name}`),
    text: "continue",
    attachments: [],
    modelSelection,
    dispatchMode: { type: "defer_start" },
  });
  const projection = yield* projections.getThreadProjection(threadId);
  const run = projection.runs[0];
  return {
    run,
    handoffs: projection.contextHandoffs.filter((handoff) => handoff.targetRunId === run?.id),
    providerThread: projection.providerThreads.find(
      (candidate) => candidate.id === run?.providerThreadId,
    ),
  };
});

it.layer(testLayer)("Orchestrator legacy-import handoff", (it) => {
  it.effect("skips the transcript replay when the imported thread resumes a native session", () =>
    Effect.gen(function* () {
      const native = yield* dispatchToImportedThread("native-import", true);
      assert.equal(native.run?.contextHandoffId, null);
      assert.deepEqual(native.handoffs, []);
      assert.deepEqual(native.providerThread?.handoffIds, []);

      const legacy = yield* dispatchToImportedThread("legacy-import", false);
      assert.deepEqual(
        legacy.handoffs.map((handoff) => handoff.strategy),
        ["manual_context"],
      );
      assert.equal(legacy.run?.contextHandoffId, legacy.handoffs[0]?.id);
    }),
  );
});
