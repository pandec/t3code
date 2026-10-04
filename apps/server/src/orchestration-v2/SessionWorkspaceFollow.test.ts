// Fork (DECISIONS 5.8): threads and Claude sessions follow each other's worktree moves.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderSession,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionCwdObservations from "./ProviderSessionCwdObservations.ts";
import {
  planSessionWorkspaceFollow,
  resolveFollowedWorkspace,
  workerLive,
} from "./SessionWorkspaceFollow.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadWorktreeSwitchScheduler from "./ThreadWorktreeSwitchScheduler.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const providerInstanceId = ProviderInstanceId.make("claude-follow-test");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "follow-model",
} satisfies ModelSelection;
const capabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

interface FollowAdapterState {
  readonly openedCwds: ReadonlyArray<string | null>;
  readonly startedCwds: ReadonlyArray<string | null>;
  /** Each opened session's event queue, so a test can speak for the provider. */
  readonly sessionEvents: ReadonlyArray<Queue.Queue<ProviderAdapterV2Event>>;
  /** Keep the next turn running; its completion waits in `heldTurns`. */
  readonly holdNextTurn?: boolean;
  readonly heldTurns?: ReadonlyArray<Effect.Effect<void>>;
}

const claudeFollowAdapter = { driver, providerInstanceId };

/** A Claude-like adapter (one thread per session) whose turns complete at once unless held. */
function makeFollowAdapter(
  state: Ref.Ref<FollowAdapterState>,
  { driver, providerInstanceId } = claudeFollowAdapter,
): ProviderAdapterV2Shape {
  return {
    instanceId: providerInstanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* Ref.update(state, (current) => ({
          ...current,
          openedCwds: [...current.openedCwds, sessionInput.runtimePolicy.cwd],
          sessionEvents: [...current.sessionEvents, events],
        }));
        const now = yield* DateTime.now;
        return {
          instanceId: providerInstanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver,
            providerInstanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
            model: sessionInput.modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver,
                providerInstanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(state, (current) => ({
                ...current,
                startedCwds: [...current.startedCwds, input.runtimePolicy.cwd],
              }));
              const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
              const complete = Effect.gen(function* () {
                const occurredAt = yield* DateTime.now;
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: input.providerThread.id,
                    nodeId: input.rootNodeId,
                    runAttemptId: input.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${providerTurnId}`,
                      strength: "strong",
                    },
                    ordinal: input.providerTurnOrdinal,
                    status: "completed",
                    startedAt: occurredAt,
                    completedAt: occurredAt,
                  },
                });
                yield* Queue.offer(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: input.providerThread.id,
                  providerTurnId,
                  runOrdinal: input.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                });
              });
              const held = yield* Ref.modify(state, (current) =>
                current.holdNextTurn === true
                  ? ([
                      true,
                      {
                        ...current,
                        holdNextTurn: false,
                        heldTurns: [...(current.heldTurns ?? []), complete],
                      },
                    ] as const)
                  : ([false, current] as const),
              );
              if (!held) yield* complete;
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

it.live("a followed move keeps the session; a T3 move restarts it in the new worktree", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "session-workspace-follow";
      const start = yield* checkpointWorkspace(`${name}-start`);
      const entered = yield* checkpointWorkspace(`${name}-entered`);
      const moved = yield* checkpointWorkspace(`${name}-moved`);
      const threadId = ThreadId.make(`thread:${name}`);
      const state = yield* Ref.make<FollowAdapterState>({
        openedCwds: [],
        startedCwds: [],
        sessionEvents: [],
      });
      const registry = ProviderAdapterRegistry.makeSingleLayer(makeFollowAdapter(state));

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const send = (step: string) =>
          Effect.gen(function* () {
            const terminal = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) => event.type === "run.updated" && event.payload.status === "completed",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`${name}:${step}`),
              threadId,
              messageId: MessageId.make(`${name}:${step}`),
              text: step,
              attachments: [],
              modelSelection,
              dispatchMode: { type: "start_immediately" },
            });
            yield* worker.drain();
            yield* Fiber.join(terminal);
            yield* worker.drain();
            return yield* orchestrator.getThreadProjection(threadId);
          });
        const detachedBy = (commandId: CommandId) =>
          eventSink.readByCommandId({ commandId }).pipe(
            Stream.runCollect,
            Effect.map((stored) =>
              [...stored].flatMap((entry) =>
                entry.event.type === "provider-session.detached"
                  ? [entry.event.payload.providerSessionId]
                  : [],
              ),
            ),
          );

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId: ProjectId.make(`project:${name}`),
          title: name,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: start,
        });
        const first = yield* send("first");
        const session = first.providerSessions.find((entry) => entry.status !== "stopped");
        if (session === undefined) return yield* Effect.die("No live provider session.");

        // The session entered a worktree itself: the thread follows it and the
        // session keeps running.
        const followCommandId = CommandId.make(`${name}:follow`);
        yield* orchestrator.dispatch({
          type: "thread.workspace.follow-session",
          commandId: followCommandId,
          threadId,
          worktreePath: entered,
          branch: "feature",
          expectedWorktreePath: start,
          providerSessionId: session.id,
          providerSessionCreatedAt: session.createdAt,
        });
        yield* worker.drain();
        assert.deepEqual(yield* detachedBy(followCommandId), []);

        // The adapter reports the session's new cwd, so a same-instance model
        // change applies in the session instead of restarting it.
        const sessionMoved = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-session.updated" && event.payload.cwd === entered,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const [sessionEvents] = (yield* Ref.get(state)).sessionEvents;
        if (sessionEvents === undefined) return yield* Effect.die("No session events.");
        yield* Queue.offer(sessionEvents, {
          type: "provider_session.updated",
          driver,
          providerSession: { ...session, cwd: entered, updatedAt: yield* DateTime.now },
        });
        yield* Fiber.join(sessionMoved);
        const modelCommandId = CommandId.make(`${name}:model`);
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: modelCommandId,
          threadId,
          modelSelection: { ...modelSelection, model: "follow-model-2" },
        });
        yield* worker.drain();
        assert.deepEqual(yield* detachedBy(modelCommandId), []);
        const followed = yield* send("second");
        assert.equal(followed.thread.worktreePath, entered);
        assert.equal(followed.thread.branch, "feature");

        // A move T3 makes restarts the session in the new worktree.
        const moveCommandId = CommandId.make(`${name}:move`);
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: moveCommandId,
          threadId,
          worktreePath: moved,
        });
        yield* worker.drain();
        assert.deepEqual(yield* detachedBy(moveCommandId), [session.id]);
        // An observation from a session that no longer runs the thread is stale.
        const staleFollow = (step: string) =>
          orchestrator
            .dispatch({
              type: "thread.workspace.follow-session",
              commandId: CommandId.make(`${name}:${step}`),
              threadId,
              worktreePath: entered,
              branch: "feature",
              expectedWorktreePath: moved,
              providerSessionId: session.id,
              providerSessionCreatedAt: session.createdAt,
            })
            .pipe(Effect.flip);
        assert.instanceOf(
          yield* staleFollow("stale-follow"),
          Orchestrator.OrchestratorDispatchError,
        );
        const third = yield* send("third");
        assert.equal(third.thread.worktreePath, moved);

        // A replacement process reuses the session id; an observation from the
        // process it replaced still must not move the thread.
        const replacement = third.providerSessions.find((entry) => entry.status !== "stopped");
        assert.equal(replacement?.id, session.id);
        assert.notEqual(
          replacement === undefined ? null : DateTime.toEpochMillis(replacement.createdAt),
          DateTime.toEpochMillis(session.createdAt),
        );
        assert.instanceOf(
          yield* staleFollow("replaced-follow"),
          Orchestrator.OrchestratorDispatchError,
        );
        const afterReplaced = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(afterReplaced.thread.worktreePath, moved);
        assert.equal(afterReplaced.thread.branch, "feature");
      }).pipe(Effect.provide(makeOrchestratorV2ReplayLayerWithRegistry({ name }, registry)));

      // One process served start and entered; only the T3 move opened another.
      const captured = yield* Ref.get(state);
      assert.deepEqual(captured.openedCwds, [start, moved]);
      assert.deepEqual(captured.startedCwds, [start, entered, moved]);
    }),
  ),
);

const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scratch = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-follow-" }),
  );
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    spawner
      .exitCode(
        ChildProcess.make(
          "git",
          ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
          { cwd },
        ),
      )
      .pipe(Effect.flatMap((code) => (Number(code) === 0 ? Effect.void : Effect.die(args))));
  const root = path.join(scratch, "repo");
  const worktree = path.join(scratch, "repo-feature");
  const other = path.join(scratch, "other");
  yield* fileSystem.makeDirectory(path.join(root, "src"), { recursive: true });
  yield* fileSystem.makeDirectory(other);
  yield* git(root, "init", "--quiet");
  yield* git(root, "commit", "--allow-empty", "--quiet", "-m", "init");
  yield* git(root, "worktree", "add", "--quiet", "-b", "feature", worktree);
  yield* git(other, "init", "--quiet");
  return { scratch, root, worktree, other, path };
});

it.effect("follows only into existing checkouts of the project's repository", () =>
  Effect.gen(function* () {
    const { scratch, root, worktree, other, path } = yield* makeRepository;
    const follow = (cwd: string) => resolveFollowedWorkspace({ workspaceRoot: root, cwd });
    assert.deepEqual(
      yield* follow(worktree),
      Option.some({ worktreePath: worktree, branch: "feature" }),
    );
    assert.deepEqual(yield* follow(root), Option.some({ worktreePath: null, branch: null }));
    assert.isTrue(Option.isNone(yield* follow(path.join(root, "src"))));
    assert.isTrue(Option.isNone(yield* follow(other)));
    assert.isTrue(Option.isNone(yield* follow(path.join(scratch, "removed"))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("follows only for the process that moved, while the thread is open", () =>
  Effect.gen(function* () {
    const { root, worktree } = yield* makeRepository;
    const createdAt = DateTime.makeUnsafe("2026-10-04T10:00:00.000Z");
    const providerSessionId = ProviderSessionId.make("provider-session:follow-plan");
    const session: OrchestrationV2ProviderSession = {
      id: providerSessionId,
      driver,
      providerInstanceId,
      status: "running",
      cwd: root,
      model: "follow-model",
      capabilities,
      createdAt,
      updatedAt: createdAt,
      lastError: null,
    };
    type PlanInput = Parameters<typeof planSessionWorkspaceFollow>[0];
    const thread: PlanInput["thread"] = {
      archivedAt: null,
      deletedAt: null,
      worktreePath: null,
      branch: null,
    };
    const observation = {
      threadId: ThreadId.make("thread:follow-plan"),
      providerSessionId,
      providerSessionCreatedAt: createdAt,
      cwd: worktree,
    };
    const plan = (overrides: Partial<Pick<PlanInput, "thread" | "providerSessions">>) =>
      planSessionWorkspaceFollow({
        observation,
        thread: overrides.thread ?? thread,
        providerSessions: overrides.providerSessions ?? [session],
        workspaceRoot: root,
      });

    assert.deepEqual(
      yield* plan({}),
      Option.some({ worktreePath: worktree, branch: "feature", expectedWorktreePath: null }),
    );
    // A later process that reuses the session id runs where T3 put it.
    assert.isTrue(
      Option.isNone(
        yield* plan({
          providerSessions: [
            { ...session, createdAt: DateTime.makeUnsafe("2026-10-04T10:05:00.000Z") },
          ],
        }),
      ),
    );
    assert.isTrue(
      Option.isNone(yield* plan({ providerSessions: [{ ...session, status: "stopped" }] })),
    );
    assert.isTrue(Option.isNone(yield* plan({ thread: { ...thread, archivedAt: createdAt } })));
    // Already there.
    assert.isTrue(
      Option.isNone(
        yield* plan({ thread: { ...thread, worktreePath: worktree, branch: "feature" } }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("the follow worker moves the thread for the live process only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "session-workspace-follow-worker";
      const { root, worktree } = yield* makeRepository;
      const threadId = ThreadId.make(`thread:${name}`);
      const projectId = ProjectId.make(`project:${name}`);
      const state = yield* Ref.make<FollowAdapterState>({
        openedCwds: [],
        startedCwds: [],
        sessionEvents: [],
      });
      const registry = ProviderAdapterRegistry.makeSingleLayer(makeFollowAdapter(state));
      const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (requested) =>
          Effect.succeed(
            requested === projectId
              ? Option.some({
                  projectId,
                  title: name,
                  workspaceRoot: root,
                  defaultModelSelection: modelSelection,
                  defaultThreadEnvMode: null,
                  autoPull: false,
                  faviconPath: null,
                  projectIcon: null,
                  scripts: [],
                  createdAt: "2026-10-04T00:00:00.000Z",
                  updatedAt: "2026-10-04T00:00:00.000Z",
                  deletedAt: null,
                })
              : Option.none(),
          ),
      });
      // One observations layer reference for the worker and the offering side,
      // as runtimeLayer.ts shares it with the adapter infrastructure.
      const observationsLayer = ProviderSessionCwdObservations.layer;
      const testLayer = Layer.mergeAll(
        workerLive.pipe(
          Layer.provide(Layer.mergeAll(observationsLayer, projects, IdAllocator.layer)),
        ),
        observationsLayer,
      ).pipe(Layer.provideMerge(makeOrchestratorV2ReplayLayerWithRegistry({ name }, registry)));

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const observations = yield* ProviderSessionCwdObservations.ProviderSessionCwdObservations;

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId,
          title: name,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: root,
        });
        const terminal = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${name}:first`),
          threadId,
          messageId: MessageId.make(`${name}:first`),
          text: "first",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* worker.drain();
        yield* Fiber.join(terminal);
        yield* worker.drain();
        const session = (yield* orchestrator.getThreadProjection(threadId)).providerSessions.find(
          (entry) => entry.status !== "stopped",
        );
        if (session === undefined) return yield* Effect.die("No live provider session.");

        const before = yield* eventSink.latestSequence({ threadId });
        const followed = yield* eventSink
          .stream({ threadId, afterSequence: before, eventType: "thread.metadata-updated" })
          .pipe(Stream.take(1), Stream.runHead, Effect.forkScoped);
        // The queue has one consumer, so the stale observation is handled first.
        // Followed, it would record the root checkout as a second update.
        yield* observations.offer({
          threadId,
          providerSessionId: session.id,
          providerSessionCreatedAt: DateTime.add(session.createdAt, { milliseconds: 1 }),
          cwd: root,
        });
        yield* observations.offer({
          threadId,
          providerSessionId: session.id,
          providerSessionCreatedAt: session.createdAt,
          cwd: worktree,
        });
        const update = yield* Fiber.join(followed);
        if (Option.isNone(update) || update.value.commandId === null) {
          return yield* Effect.die("No follow update.");
        }
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.thread.worktreePath, worktree);
        assert.equal(projection.thread.branch, "feature");
        const latest = yield* eventSink.latestSequence({ threadId });
        const written = yield* eventSink.stream({ threadId, afterSequence: before }).pipe(
          Stream.takeUntil((stored) => stored.sequence >= latest),
          Stream.runCollect,
        );
        assert.lengthOf(
          [...written].filter((stored) => stored.event.type === "thread.metadata-updated"),
          1,
        );
        const byFollow = yield* eventSink
          .readByCommandId({ commandId: update.value.commandId })
          .pipe(Stream.runCollect);
        assert.isFalse(
          [...byFollow].some((stored) => stored.event.type === "provider-session.detached"),
        );
      }).pipe(Effect.provide(testLayer));

      assert.deepEqual((yield* Ref.get(state)).openedCwds, [root]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

// Fork (DECISIONS 2.5 x 5.8): a completed agent-requested switch is a T3 move,
// so the live session is detached and the next turn starts in the new checkout.
it.live("a completed worktree switch restarts the session in the new worktree", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "deferred-worktree-switch-session";
      const { root, worktree } = yield* makeRepository;
      const threadId = ThreadId.make(`thread:${name}`);
      const projectId = ProjectId.make(`project:${name}`);
      // Scheduling a switch is Codex-only (DeferredWorktreeSwitch.ts).
      const codexAdapter = {
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-switch-test"),
      };
      const codexSelection = {
        instanceId: codexAdapter.providerInstanceId,
        model: "switch-model",
      } satisfies ModelSelection;
      const state = yield* Ref.make<FollowAdapterState>({
        openedCwds: [],
        startedCwds: [],
        sessionEvents: [],
        holdNextTurn: true,
      });
      const registry = ProviderAdapterRegistry.makeSingleLayer(
        makeFollowAdapter(state, codexAdapter),
      );
      const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
        getShell: (requested) =>
          Effect.succeed(
            requested === projectId
              ? Option.some({
                  id: projectId,
                  title: name,
                  workspaceRoot: root,
                  defaultModelSelection: codexSelection,
                  scripts: [],
                  createdAt: "2026-10-04T00:00:00.000Z",
                  updatedAt: "2026-10-04T00:00:00.000Z",
                })
              : Option.none(),
          ),
      });
      const threads = Layer.unwrap(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          return Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: orchestrator.dispatch,
            getThreadRecords: orchestrator.getThreadRecords,
            getThreadShell: orchestrator.getThreadShell,
            streamDomainEvents: orchestrator.streamDomainEvents,
          });
        }),
      );
      // The scheduler runs as on the server: driven by domain events.
      const testLayer = ThreadWorktreeSwitchScheduler.workerLive.pipe(
        Layer.provideMerge(ThreadWorktreeSwitchScheduler.layer),
        Layer.provide(Layer.mergeAll(threads, projects, SqlitePersistenceMemory)),
        Layer.provideMerge(makeOrchestratorV2ReplayLayerWithRegistry({ name }, registry)),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const scheduler = yield* ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler;
        const send = (step: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${name}:${step}`),
            threadId,
            messageId: MessageId.make(`${name}:${step}`),
            text: step,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId,
          title: name,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: root,
        });
        yield* send("first");
        yield* worker.drain();
        const session = (yield* orchestrator.getThreadProjection(threadId)).providerSessions.find(
          (entry) => entry.status !== "stopped",
        );
        if (session === undefined) return yield* Effect.die("No live provider session.");

        // The agent asks from its running turn; the switch waits for the turn.
        const pending = yield* scheduler.request({ threadId, targetPath: worktree });
        assert.equal(pending.request?.status, "pending");
        assert.equal((yield* orchestrator.getThreadProjection(threadId)).thread.worktreePath, root);

        const before = yield* eventSink.latestSequence({ threadId });
        const switched = yield* eventSink
          .stream({ threadId, afterSequence: before, eventType: "thread.metadata-updated" })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "thread.metadata-updated" &&
                stored.event.payload.worktreeSwitch?.status === "completed",
            ),
            Stream.take(1),
            Stream.runHead,
            Effect.forkScoped,
          );
        const [completeFirstTurn] = (yield* Ref.get(state)).heldTurns ?? [];
        if (completeFirstTurn === undefined) return yield* Effect.die("The turn was not held.");
        yield* completeFirstTurn;
        const update = yield* Fiber.join(switched);
        if (Option.isNone(update) || update.value.commandId === null) {
          return yield* Effect.die("No completed switch.");
        }
        yield* worker.drain();

        const afterSwitch = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(afterSwitch.thread.worktreePath, worktree);
        assert.equal(afterSwitch.thread.branch, "feature");
        assert.equal(afterSwitch.thread.worktreeSwitch?.requestId, pending.request?.requestId);
        const bySwitch = yield* eventSink
          .readByCommandId({ commandId: update.value.commandId })
          .pipe(Stream.runCollect);
        assert.deepEqual(
          [...bySwitch].flatMap((stored) =>
            stored.event.type === "provider-session.detached"
              ? [stored.event.payload.providerSessionId]
              : [],
          ),
          [session.id],
        );

        const secondDone = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* send("second");
        yield* worker.drain();
        yield* Fiber.join(secondDone);
      }).pipe(Effect.provide(testLayer));

      // The next turn opened a new process in the worktree.
      const captured = yield* Ref.get(state);
      assert.deepEqual(captured.openedCwds, [root, worktree]);
      assert.deepEqual(captured.startedCwds, [root, worktree]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
