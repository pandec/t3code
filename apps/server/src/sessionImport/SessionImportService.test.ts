import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SessionImportError,
} from "@t3tools/contracts";
import { formatForkedThreadTitle } from "@t3tools/shared/composerTrigger";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderImportedSession, ProviderSessionImport } from "./ProviderSessionImport.ts";
import * as SessionImportService from "./SessionImportService.ts";

const projectId = ProjectId.make("project:session-import");
const workspaceRoot = "/nonexistent/session-import/project";
const instanceId = ProviderInstanceId.make("claude_personal");
const sessionId = "11111111-1111-4111-8111-111111111111";
const forkedSessionId = "22222222-2222-4222-8222-222222222222";
const model = "claude-sonnet-4-5";

const session: ProviderImportedSession = {
  nativeSessionId: sessionId,
  name: "Fix the parser",
  model,
  messages: [
    { role: "user", text: "Fix the parser", createdAt: "2026-09-01T10:00:00.000Z" },
    { role: "assistant", text: "Fixed it.", createdAt: "2026-09-01T10:01:00.000Z" },
  ],
};

const forks: Array<string> = [];
const sessionImport: ProviderSessionImport = {
  listSessions: () =>
    Effect.succeed([
      {
        nativeSessionId: sessionId,
        name: session.name,
        preview: "Fix the parser",
        messageCount: 2,
        updatedAt: "2026-09-01T10:01:00.000Z",
      },
    ]),
  readSession: () => Effect.succeed(session),
  forkSession: ({ nativeSessionId }) =>
    Effect.sync(() => {
      forks.push(nativeSessionId);
      return forkedSessionId;
    }),
};

const claudeInstance = {
  instanceId,
  driverKind: ProviderDriverKind.make("claudeAgent"),
  continuationIdentity: {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    continuationKey: "claude:home:/home/user/.claude",
  },
  displayName: "Claude personal",
  enabled: true,
  snapshot: {
    getSnapshot: Effect.succeed({
      displayName: "Claude",
      models: [{ slug: model, name: "Sonnet", isCustom: false, capabilities: null }],
    }),
  },
  sessionImport,
} as unknown as ProviderInstance;

const projectionTestLayer = Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

/** Writes go straight into the real projection, so lookups read what an import persisted. */
const dependencies = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return Layer.mergeAll(
      Layer.mock(EventSink.EventSinkV2)({
        write: (input) =>
          Effect.forEach(input.events, (event) => projections.apply(event), {
            discard: true,
          }).pipe(Effect.as([]), Effect.orDie),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadShell: (threadId) => projections.getThreadShell(threadId).pipe(Effect.orDie),
        getThreadRecords: (threadId, fields) =>
          projections
            .getThreadRecords(threadId, fields)
            .pipe(
              Effect.mapError(() => new Orchestrator.OrchestratorProjectionError({ threadId })),
            ),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            id === projectId ? Option.some({ id, workspaceRoot } as never) : Option.none(),
          ),
      }),
      Layer.mock(ProviderInstanceRegistry)({
        getInstance: (id) => Effect.succeed(id === instanceId ? claudeInstance : undefined),
        listInstances: Effect.succeed([claudeInstance]),
      }),
      IdAllocator.layer,
      NodeCrypto.layer,
      NodeServices.layer,
    );
  }),
);

const TestLayer = SessionImportService.layer.pipe(
  Layer.provideMerge(dependencies),
  Layer.provideMerge(projectionTestLayer),
);

const createProject = Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
  projects.apply({
    sequence: 0,
    eventId: EventId.make(`created:${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: "2026-09-01T09:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Session import",
      workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-09-01T09:00:00.000Z",
      updatedAt: "2026-09-01T09:00:00.000Z",
    },
  }),
);

const importFailure = <A>(effect: Effect.Effect<A, SessionImportError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

it.layer(TestLayer)("SessionImportService", (it) => {
  it.effect("imports a session as resumable history, then only as a native fork", () =>
    Effect.gen(function* () {
      yield* createProject;
      const service = yield* SessionImportService.SessionImportService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;

      const before = yield* service.listCandidates({ projectId });
      assert.deepEqual(
        before.map((candidate) => [candidate.nativeSessionId, candidate.linkedThread]),
        [[sessionId, null]],
      );

      const imported = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: sessionId,
      });
      const records = yield* projections.getThreadRecords(imported.threadId, [
        "providerThreads",
        "messages",
      ]);
      assert.equal(records.thread.title, "Fix the parser");
      assert.equal(records.thread.historyOrigin, "v1_import");
      assert.deepEqual(records.thread.modelSelection, { instanceId, model });
      assert.deepEqual(
        records.messages.map((message) => [message.role, message.text]),
        [
          ["user", "Fix the parser"],
          ["assistant", "Fixed it."],
        ],
      );
      const providerThread = records.providerThreads.find(
        (candidate) => candidate.id === records.thread.activeProviderThreadId,
      );
      assert.deepEqual(providerThread?.nativeThreadRef, {
        driver: ProviderDriverKind.make("claudeAgent"),
        nativeId: sessionId,
        strength: "strong",
      });

      // The session is now owned: listed as linked, and a plain re-import is refused.
      const after = yield* service.listCandidates({ projectId });
      assert.equal(after[0]?.linkedThread?.threadId, imported.threadId);
      assert.equal(after[0]?.linkedThread?.canFork, true);
      const duplicate = yield* service
        .importSession({ projectId, instanceId, nativeSessionId: sessionId })
        .pipe(Effect.flip);
      assert.equal(duplicate.reason, "already-imported");
      assert.equal(duplicate.existingThreadId, imported.threadId);

      // A fork copies the session to a new native id so the two threads never share it.
      const forked = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: sessionId,
        fork: true,
      });
      assert.deepEqual(forks, [sessionId]);
      assert.notEqual(forked.threadId, imported.threadId);
      const forkRecords = yield* projections.getThreadRecords(forked.threadId, ["providerThreads"]);
      assert.equal(forkRecords.thread.title, formatForkedThreadTitle("Fix the parser"));
      assert.equal(
        forkRecords.providerThreads.find(
          (candidate) => candidate.id === forkRecords.thread.activeProviderThreadId,
        )?.nativeThreadRef?.nativeId,
        forkedSessionId,
      );
    }),
  );
});

it.layer(TestLayer)("SessionImportService validation", (it) => {
  it.effect("rejects models the instance does not advertise and unknown instances", () =>
    Effect.gen(function* () {
      const service = yield* SessionImportService.SessionImportService;
      assert.equal(
        yield* importFailure(
          service.importSession({
            projectId,
            instanceId,
            nativeSessionId: sessionId,
            modelSelection: { instanceId, model: "not-a-model" },
          }),
        ),
        "invalid-model",
      );
      assert.equal(
        yield* importFailure(
          service.importSession({
            projectId,
            instanceId: ProviderInstanceId.make("missing"),
            nativeSessionId: sessionId,
          }),
        ),
        "instance-not-found",
      );
    }),
  );
});

it("titles an unnamed import from its first substantive user message", () => {
  const at = DateTime.formatIso(DateTime.makeUnsafe(0));
  assert.equal(
    SessionImportService.titleForImport(null, [
      { role: "assistant", text: "Hello", createdAt: at },
      { role: "user", text: "Refactor the queue\nwith details", createdAt: at },
    ]),
    "Refactor the queue",
  );
  assert.equal(SessionImportService.titleForImport("  Named  ", []), "Named");
});
