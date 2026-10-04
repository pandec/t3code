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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { planSessionWorkspaceFollow, resolveFollowedWorkspace } from "./SessionWorkspaceFollow.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
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
}

/** A Claude-like adapter (one thread per session) whose turns complete at once. */
function makeFollowAdapter(state: Ref.Ref<FollowAdapterState>): ProviderAdapterV2Shape {
  return {
    instanceId: providerInstanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        yield* Ref.update(state, (current) => ({
          ...current,
          openedCwds: [...current.openedCwds, sessionInput.runtimePolicy.cwd],
        }));
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
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
          type: "thread.metadata.update",
          commandId: followCommandId,
          threadId,
          worktreePath: entered,
          branch: "feature",
          expectedWorktreePath: start,
          followsProviderSessionId: session.id,
        });
        yield* worker.drain();
        assert.deepEqual(yield* detachedBy(followCommandId), []);
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
        const stale = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${name}:stale-follow`),
            threadId,
            worktreePath: entered,
            expectedWorktreePath: moved,
            followsProviderSessionId: session.id,
          })
          .pipe(Effect.flip);
        assert.instanceOf(stale, Orchestrator.OrchestratorDispatchError);
        const third = yield* send("third");
        assert.equal(third.thread.worktreePath, moved);
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
