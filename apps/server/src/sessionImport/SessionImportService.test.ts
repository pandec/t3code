import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type SessionImportError,
  ThreadId,
} from "@t3tools/contracts";
import { formatForkedThreadTitle } from "@t3tools/shared/composerTrigger";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderImportedSession, ProviderSessionImport } from "./ProviderSessionImport.ts";
import * as SessionImportService from "./SessionImportService.ts";
import * as StrictResume from "./StrictResume.ts";

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

const projectionTestLayer = Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

interface HarnessOptions {
  readonly driver?: "claudeAgent" | "codex";
  /** Replaces the registry's instance object once the session read returns. */
  readonly replaceInstanceDuringRead?: boolean;
  /** Replaces the registry's instance object once the native fork returns. */
  readonly replaceInstanceDuringFork?: boolean;
  /** Reports the owner thread as running once the session read returns. */
  readonly ownerStartsRunDuringRead?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const driverKind = ProviderDriverKind.make(options.driver ?? "claudeAgent");
  const forks: Array<string> = [];
  const state = { writes: 0, readReturned: false };
  /** The project's checkout; a test may point it at a real repository. */
  const project = { workspaceRoot };
  /** Workspaces the provider was asked to list and read sessions in. */
  const cwds: Array<string> = [];
  let current: ProviderInstance;
  const replaceInstance = () => {
    current = { ...current } as ProviderInstance;
  };
  const sessionImport: ProviderSessionImport = {
    listSessions: ({ cwd }) =>
      Effect.sync(() => {
        cwds.push(cwd);
        return [
          {
            nativeSessionId: sessionId,
            name: session.name,
            preview: "Fix the parser",
            messageCount: 2,
            updatedAt: "2026-09-01T10:01:00.000Z",
          },
        ];
      }),
    readSession: ({ nativeSessionId, cwd }) =>
      Effect.sync(() => {
        cwds.push(cwd);
        state.readReturned = true;
        if (options.replaceInstanceDuringRead === true) replaceInstance();
        return { ...session, nativeSessionId };
      }),
    forkSession: ({ nativeSessionId }) =>
      Effect.sync(() => {
        forks.push(nativeSessionId);
        if (options.replaceInstanceDuringFork === true) replaceInstance();
        return forkedSessionId;
      }),
  };
  current = {
    instanceId,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: `${driverKind}:home:/home/user` },
    displayName: "Personal",
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed({
        displayName: "Provider",
        models: [{ slug: model, name: "Sonnet", isCustom: false, capabilities: null }],
      }),
    },
    sessionImport,
  } as unknown as ProviderInstance;

  /** Writes go straight into the real projection, so lookups read what an import persisted. */
  const dependencies = Layer.unwrap(
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      return Layer.mergeAll(
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              state.writes += 1;
            }).pipe(
              Effect.andThen(
                Effect.forEach(input.events, (event) => projections.apply(event), {
                  discard: true,
                }),
              ),
              Effect.as([]),
              Effect.orDie,
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadShell: (threadId) =>
            projections.getThreadShell(threadId).pipe(
              Effect.map((shell) =>
                shell !== null && options.ownerStartsRunDuringRead === true && state.readReturned
                  ? { ...shell, activeRunId: RunId.make("run-started-meanwhile") }
                  : shell,
              ),
              Effect.orDie,
            ),
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
              id === projectId
                ? Option.some({ id, workspaceRoot: project.workspaceRoot } as never)
                : Option.none(),
            ),
        }),
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: (id) => Effect.sync(() => (id === instanceId ? current : undefined)),
          listInstances: Effect.sync(() => [current]),
        }),
        IdAllocator.layer,
        NodeCrypto.layer,
        NodeServices.layer,
      );
    }),
  );

  const layer = SessionImportService.layer.pipe(
    Layer.provideMerge(dependencies),
    Layer.provideMerge(StrictResume.layer),
    Layer.provideMerge(projectionTestLayer),
  );
  return { layer, forks, state, project, cwds };
}

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

const main = makeHarness();

it.layer(main.layer)("SessionImportService", (it) => {
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
      assert.deepEqual(main.forks, [sessionId]);
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

const worktreeHarness = makeHarness();

/** A repository with one commit and a linked worktree on `feature`. */
const makeRepositoryWithWorktree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-import-wt-" }));
  const repository = path.join(root, "repo");
  const worktreePath = path.join(root, "worktree");
  yield* fs.makeDirectory(repository);
  const git = (args: ReadonlyArray<string>) =>
    ProcessRunner.ProcessRunner.pipe(
      Effect.flatMap((runner) => runner.run({ command: "git", args: ["-C", repository, ...args] })),
      Effect.provide(ProcessRunner.layer),
    );
  yield* git(["init", "-q"]);
  yield* git([
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=T",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  yield* git(["worktree", "add", "-q", "-b", "feature", worktreePath]);
  return { repository, worktreePath };
});

it.layer(worktreeHarness.layer)("SessionImportService worktrees", (it) => {
  it.effect("lists and imports a session in an existing worktree of the project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { repository, worktreePath } = yield* makeRepositoryWithWorktree;
        worktreeHarness.project.workspaceRoot = repository;
        yield* createProject;
        const service = yield* SessionImportService.SessionImportService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;

        yield* service.listCandidates({ projectId, cwd: worktreePath });
        assert.deepEqual(worktreeHarness.cwds, [worktreePath]);

        assert.equal(
          yield* importFailure(
            service.importSession({
              projectId,
              instanceId,
              nativeSessionId: sessionId,
              worktree: { branch: "main-elsewhere", worktreePath },
            }),
          ),
          "invalid-worktree",
        );

        const imported = yield* service.importSession({
          projectId,
          instanceId,
          nativeSessionId: sessionId,
          worktree: { branch: "feature", worktreePath },
        });
        assert.deepEqual(worktreeHarness.cwds, [worktreePath, worktreePath]);
        const records = yield* projections.getThreadRecords(imported.threadId, []);
        assert.equal(records.thread.branch, "feature");
        assert.equal(records.thread.worktreePath, worktreePath);
      }),
    ),
  );
});

it.layer(makeHarness().layer)("SessionImportService validation", (it) => {
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

const activeNativeId = Effect.fn(function* (threadId: ThreadId) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const records = yield* projections.getThreadRecords(threadId, ["providerThreads", "messages"]);
  const providerThread = records.providerThreads.find(
    (candidate) => candidate.id === records.thread.activeProviderThreadId,
  );
  return { records, providerThread, nativeId: providerThread?.nativeThreadRef?.nativeId };
});

const runlessFork = makeHarness();
it.layer(runlessFork.layer)("SessionImportService runless fork", (it) => {
  it.effect("forks an imported thread natively before it starts a turn", () =>
    Effect.gen(function* () {
      yield* createProject;
      const service = yield* SessionImportService.SessionImportService;
      const strict = yield* StrictResume.StrictResume;
      const imported = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: sessionId,
      });
      const source = yield* activeNativeId(imported.threadId);
      // Claude imports keep v2's resume fallback.
      assert.isFalse(yield* strict.isStrict(source.providerThread!.id));

      const forked = yield* service.forkImportedThread({ threadId: imported.threadId });
      assert.deepEqual(runlessFork.forks, [sessionId]);
      assert.notEqual(forked.threadId, imported.threadId);
      const fork = yield* activeNativeId(forked.threadId);
      assert.equal(fork.nativeId, forkedSessionId);
      assert.equal(fork.records.thread.title, formatForkedThreadTitle("Fix the parser"));
      assert.deepEqual(
        fork.records.messages.map((message) => [message.role, message.text]),
        [
          ["user", "Fix the parser"],
          ["assistant", "Fixed it."],
        ],
      );
      // The source keeps continuing its own native session.
      assert.equal((yield* activeNativeId(imported.threadId)).nativeId, sessionId);
    }),
  );
});

it.layer(makeHarness().layer)("SessionImportService runless fork modes", (it) => {
  it.effect("keeps the source thread's runtime and interaction modes", () =>
    Effect.gen(function* () {
      yield* createProject;
      const service = yield* SessionImportService.SessionImportService;
      const eventSink = yield* EventSink.EventSinkV2;
      const imported = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: sessionId,
      });
      const source = (yield* activeNativeId(imported.threadId)).records.thread;
      // Explicit imports start with the defaults.
      assert.equal(source.runtimeMode, "full-access");
      assert.equal(source.interactionMode, "default");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("test:runtime-mode"),
            type: "thread.runtime-mode-updated",
            threadId: imported.threadId,
            occurredAt: source.updatedAt,
            payload: { ...source, runtimeMode: "approval-required" },
          },
          {
            id: EventId.make("test:interaction-mode"),
            type: "thread.interaction-mode-updated",
            threadId: imported.threadId,
            occurredAt: source.updatedAt,
            payload: { ...source, runtimeMode: "approval-required", interactionMode: "plan" },
          },
        ],
      });

      const forked = yield* service.forkImportedThread({ threadId: imported.threadId });
      const fork = (yield* activeNativeId(forked.threadId)).records.thread;
      assert.equal(fork.runtimeMode, "approval-required");
      assert.equal(fork.interactionMode, "plan");
    }),
  );
});

it.layer(makeHarness().layer)("SessionImportService deleted owner", (it) => {
  it.effect("refuses a session whose deleted thread is still detaching its provider", () =>
    Effect.gen(function* () {
      yield* createProject;
      const service = yield* SessionImportService.SessionImportService;
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const imported = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: sessionId,
      });
      const thread = (yield* activeNativeId(imported.threadId)).records.thread;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("test:thread-deleted"),
            type: "thread.deleted",
            threadId: imported.threadId,
            occurredAt: thread.updatedAt,
            payload: { ...thread, deletedAt: thread.updatedAt },
          },
        ],
      });
      const at = DateTime.formatIso(thread.updatedAt);
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at
        ) VALUES (
          'effect:test:detach', 'command:test:delete', ${imported.threadId},
          'provider-session.detach', '{}', 'pending', 0, ${at}, ${at}, ${at}
        )
      `;
      const error = yield* service
        .importSession({ projectId, instanceId, nativeSessionId: sessionId })
        .pipe(Effect.flip);
      assert.equal(error.reason, "import-failed");
      assert.include(error.detail, "still shutting down");

      yield* sql`
        UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'
        WHERE effect_id = 'effect:test:detach'
      `;
      const reimported = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: sessionId,
      });
      assert.notEqual(reimported.threadId, imported.threadId);
      assert.equal((yield* activeNativeId(reimported.threadId)).nativeId, sessionId);
    }),
  );
});

it.layer(makeHarness({ driver: "codex" }).layer)("SessionImportService strict resume", (it) => {
  it.effect("marks plain Codex imports strict, but not the native forks T3 creates", () =>
    Effect.gen(function* () {
      yield* createProject;
      const service = yield* SessionImportService.SessionImportService;
      const strict = yield* StrictResume.StrictResume;
      const imported = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: sessionId,
      });
      const source = yield* activeNativeId(imported.threadId);
      assert.isTrue(yield* strict.isStrict(source.providerThread!.id));

      const forked = yield* service.forkImportedThread({ threadId: imported.threadId });
      const fork = yield* activeNativeId(forked.threadId);
      assert.isFalse(yield* strict.isStrict(fork.providerThread!.id));
    }),
  );
});

it.layer(makeHarness().layer)("SessionImportService concurrent import", (it) => {
  it.effect("refuses a session another importer attached after the ownership check", () =>
    Effect.gen(function* () {
      yield* createProject;
      const service = yield* SessionImportService.SessionImportService;
      const eventSink = yield* EventSink.EventSinkV2;
      const imported = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: sessionId,
      });
      const template = (yield* activeNativeId(imported.threadId)).records.thread;
      // A live thread at the deterministic id with no provider thread yet, as
      // the bulk importer leaves it mid-write: invisible to the owner lookup.
      const otherSessionId = "33333333-3333-4333-8333-333333333333";
      const raced = ThreadId.make(`import:${instanceId}:${otherSessionId}`);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`test:thread:${raced}:created`),
            type: "thread.created",
            threadId: raced,
            providerInstanceId: instanceId,
            occurredAt: template.createdAt,
            payload: {
              ...template,
              id: raced,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: raced },
            },
          },
        ],
      });
      const error = yield* service
        .importSession({ projectId, instanceId, nativeSessionId: otherSessionId })
        .pipe(Effect.flip);
      assert.equal(error.reason, "already-imported");
      assert.equal(error.existingThreadId, raced);
    }),
  );
});

const replacedDuringRead = makeHarness({ replaceInstanceDuringRead: true });
it.layer(replacedDuringRead.layer)("SessionImportService instance replaced on read", (it) => {
  it.effect("refuses to persist a session read from a replaced provider instance", () =>
    Effect.gen(function* () {
      yield* createProject;
      const service = yield* SessionImportService.SessionImportService;
      assert.equal(
        yield* importFailure(
          service.importSession({ projectId, instanceId, nativeSessionId: sessionId }),
        ),
        "instance-not-found",
      );
      assert.equal(replacedDuringRead.state.writes, 0);
    }),
  );
});

const replacedDuringFork = makeHarness({ replaceInstanceDuringFork: true });
it.layer(replacedDuringFork.layer)("SessionImportService instance replaced on fork", (it) => {
  it.effect("refuses to persist a fork made in a replaced provider instance", () =>
    Effect.gen(function* () {
      yield* createProject;
      const service = yield* SessionImportService.SessionImportService;
      yield* service.importSession({ projectId, instanceId, nativeSessionId: sessionId });
      assert.equal(replacedDuringFork.state.writes, 1);
      assert.equal(
        yield* importFailure(
          service.importSession({ projectId, instanceId, nativeSessionId: sessionId, fork: true }),
        ),
        "import-failed",
      );
      assert.deepEqual(replacedDuringFork.forks, [sessionId]);
      assert.equal(replacedDuringFork.state.writes, 1);
    }),
  );
});

const ownerStartsRun = makeHarness({ ownerStartsRunDuringRead: true });
it.layer(ownerStartsRun.layer)("SessionImportService fork readiness", (it) => {
  it.effect("refuses a fork when the owner starts a turn while the session is read", () =>
    Effect.gen(function* () {
      yield* createProject;
      const service = yield* SessionImportService.SessionImportService;
      yield* service.importSession({ projectId, instanceId, nativeSessionId: sessionId });
      ownerStartsRun.state.readReturned = false;
      assert.equal(
        yield* importFailure(
          service.importSession({ projectId, instanceId, nativeSessionId: sessionId, fork: true }),
        ),
        "import-failed",
      );
      assert.deepEqual(ownerStartsRun.forks, []);
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
