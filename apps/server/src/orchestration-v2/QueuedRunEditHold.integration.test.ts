import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  QUEUED_RUN_EDIT_HOLD_LEASE_MS,
  ThreadId,
  type RunId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import { WORKTREE_SWITCH_DETAIL } from "./DeferredWorktreeSwitch.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2,
  ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

const providerTurnFor = (
  turn: ProviderAdapterV2TurnInput,
  now: DateTime.Utc,
): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
  providerThreadId: turn.providerThread.id,
  nodeId: turn.rootNodeId,
  runAttemptId: turn.attemptId,
  nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
  ordinal: turn.providerTurnOrdinal,
  status: "running",
  startedAt: now,
  completedAt: null,
});

/** A fake Codex adapter whose turns run until the test ends them. */
const makeHarness = (name: string) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const started: Array<ProviderAdapterV2TurnInput> = [];
    const steered: Array<string> = [];
    // While set, started turns wait for the test to report them running.
    const deferRunning = { current: false };
    const adapter: ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd,
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: ({ threadId }) =>
              Effect.succeed({
                id: ProviderThreadId.make(`provider-thread:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) =>
              Effect.gen(function* () {
                started.push(turn);
                if (deferRunning.current) return;
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: providerTurnFor(turn, yield* DateTime.now),
                });
              }),
            steerTurn: (turn) =>
              Effect.sync(() => {
                steered.push(turn.message.text);
              }),
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    const layer = ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerSingle(adapter),
      { runEffectWorker: false },
    );
    return { cwd, events, started, steered, deferRunning, layer };
  });

const scenario = (name: string) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(name);
    const threadId = ThreadId.make(`thread:${name}`);
    const setup = Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((collected) => Array.from(collected)[0]!),
          Effect.forkScoped({ startImmediately: true }),
        );
      const send = (id: string, mode: "start" | "queue") =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(`message:${id}`),
          text: id,
          attachments: [],
          dispatchMode: { type: mode === "queue" ? "queue_after_active" : "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
      const hold = (id: string, runId: RunId, held: boolean, holderId = "editor") =>
        orchestrator.dispatch({
          type: "queued-run.edit-hold",
          commandId: CommandId.make(id),
          threadId,
          runId,
          held,
          holderId,
        });
      // Ends a started turn (the first, active one by default) so the queue would normally start.
      const endTurn = (index: number) =>
        Effect.gen(function* () {
          const turnInput = harness.started[index]!;
          const activeTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns.find(
            (turn) => turn.runAttemptId === turnInput.attemptId,
          )!;
          const activeEnded = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === turnInput.runId &&
              event.payload.status === "waiting",
          );
          yield* Queue.offer(harness.events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...activeTurn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(harness.events, {
            type: "turn.terminal",
            driver,
            providerThreadId: activeTurn.providerThreadId,
            providerTurnId: activeTurn.id,
            runOrdinal: turnInput.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(activeEnded);
          yield* worker.drain();
        });
      const endActiveTurn = endTurn(0);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make(`project:${name}`),
        title: "Queued message edit hold",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: harness.cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const firstRunning = yield* watch(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* send("active", "start");
      yield* worker.drain();
      yield* Fiber.join(firstRunning);
      return { orchestrator, worker, watch, send, hold, endTurn, endActiveTurn };
    });
    return { ...harness, threadId, setup };
  });

it.effect(
  "keeps a queued message from starting while it is edited, then starts the saved edit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, threadId, setup, layer } = yield* scenario("edit-hold-release");
        yield* Effect.gen(function* () {
          const { orchestrator, worker, watch, send, hold, endActiveTurn } = yield* setup;
          yield* send("queued", "queue");
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.status === "queued",
          )!;
          yield* hold("hold", queued.id, true);
          assert.isDefined(
            (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.id === queued.id,
            )?.editHeldUntil,
          );

          yield* endActiveTurn;
          // The turn ended, but the edited message keeps waiting and cannot be steered.
          assert.equal(started.length, 1);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.id === queued.id,
            )?.status,
            "queued",
          );
          const promoted = yield* orchestrator
            .dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("promote-held"),
              threadId,
              queuedRunId: queued.id,
              targetRunId: started[0]!.runId,
            })
            .pipe(Effect.flip);
          assert.equal(promoted._tag, "OrchestratorDispatchError");

          yield* orchestrator.dispatch({
            type: "queued-run.edit",
            commandId: CommandId.make("save-edit"),
            threadId,
            runId: queued.id,
            text: "edited",
          });
          const queuedStarting = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === queued.id &&
              event.payload.status === "starting",
          );
          yield* hold("release", queued.id, false);
          yield* Fiber.join(queuedStarting);
          yield* worker.drain();

          assert.equal(started.length, 2);
          assert.equal(started[1]!.runId, queued.id);
          assert.equal(started[1]!.message.text, "edited");
          assert.deepEqual(steered, []);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("resumes the queue once an abandoned edit hold lapses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, threadId, setup, layer } = yield* scenario("edit-hold-lapse");
      yield* Effect.gen(function* () {
        const { orchestrator, worker, watch, send, hold, endActiveTurn } = yield* setup;
        yield* send("queued", "queue");
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        const heldAt = yield* DateTime.now;
        yield* hold("hold", queued.id, true);
        yield* endActiveTurn;
        assert.equal(started.length, 1);

        const queuedStarting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === queued.id &&
            event.payload.status === "starting",
        );
        yield* TestClock.adjust(Duration.millis(QUEUED_RUN_EDIT_HOLD_LEASE_MS));
        const startingEvent = yield* Fiber.join(queuedStarting);
        yield* worker.drain();

        assert.isFalse(
          DateTime.isLessThan(
            startingEvent.occurredAt,
            DateTime.add(heldAt, { milliseconds: QUEUED_RUN_EDIT_HOLD_LEASE_MS }),
          ),
        );
        assert.equal(started.length, 2);
        assert.equal(started[1]!.runId, queued.id);
        assert.isUndefined(
          (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === queued.id,
          )?.editHeldUntil,
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("holds the queue after a provider failure even while a message is being edited", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, events, threadId, setup, layer } = yield* scenario("edit-hold-failure");
      yield* Effect.gen(function* () {
        const { orchestrator, worker, watch, send, hold } = yield* setup;
        yield* send("queued", "queue");
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        yield* hold("hold", queued.id, true);

        const turnInput = started[0]!;
        const activeTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns.find(
          (turn) => turn.runAttemptId === turnInput.attemptId,
        )!;
        const failed = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === turnInput.runId &&
            event.payload.status === "failed",
        );
        const queueHeld = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === queued.id &&
            event.payload.queueHeld === true,
        );
        const failure = makeProviderFailure({ class: "provider_error", message: "provider down" });
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...activeTurn, status: "failed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: activeTurn.providerThreadId,
          providerTurnId: activeTurn.id,
          runOrdinal: turnInput.runOrdinal,
          status: "failed",
          failure,
          failureItemOrdinal: 101,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(failed);
        yield* Fiber.join(queueHeld);
        yield* worker.drain();

        const heldRun = () =>
          orchestrator
            .getThreadProjection(threadId)
            .pipe(Effect.map((projection) => projection.runs.find((run) => run.id === queued.id)));
        // The failure holds the queue although the edit hold kept the message from being picked.
        assert.isTrue((yield* heldRun())?.queueHeld);

        // Releasing the edit does not send the message the failure held.
        yield* hold("release", queued.id, false);
        yield* worker.drain();
        assert.equal(started.length, 1);
        assert.equal((yield* heldRun())?.status, "queued");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps a queued message held until every editing client releases it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, threadId, setup, layer } = yield* scenario("edit-hold-two-holders");
      yield* Effect.gen(function* () {
        const { orchestrator, worker, watch, send, hold, endActiveTurn } = yield* setup;
        yield* send("queued", "queue");
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        yield* hold("hold-web", queued.id, true, "web");
        yield* hold("hold-mobile", queued.id, true, "mobile");
        yield* endActiveTurn;

        yield* hold("release-web", queued.id, false, "web");
        yield* worker.drain();
        // Mobile still edits, so the web release does not start the message.
        assert.equal(started.length, 1);
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(threadId)).runs
            .find((run) => run.id === queued.id)
            ?.editHolds?.map((lease) => lease.holderId),
          ["mobile"],
        );

        const queuedStarting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === queued.id &&
            event.payload.status === "starting",
        );
        yield* hold("release-mobile", queued.id, false, "mobile");
        yield* Fiber.join(queuedStarting);
        yield* worker.drain();
        assert.equal(started.length, 2);
        assert.equal(started[1]!.runId, queued.id);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect(
  "releases a batch only on its turn's first running update, not on later usage updates",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, events, deferRunning, threadId, setup, layer } =
          yield* scenario("edit-hold-batch-usage");
        yield* Effect.gen(function* () {
          const { orchestrator, worker, watch, send, hold, endTurn } = yield* setup;
          yield* send("leader", "queue");
          yield* send("follower", "queue");
          yield* send("held", "queue");
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs
            .filter((run) => run.status === "queued")
            .toSorted((left, right) => left.ordinal - right.ordinal);
          const [leader, follower, held] = queued;

          // The leader starts with the follower and the third message stamped
          // into its batch; the edit begins before the leader's turn runs.
          deferRunning.current = true;
          yield* endTurn(0);
          assert.equal(started[1]!.runId, leader!.id);
          yield* hold("hold", held!.id, true);
          const stamped = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === held!.id,
          );
          assert.equal(stamped?.queueBatchLeaderRunId, leader!.id);
          assert.isDefined(stamped?.editHeldUntil);

          // The leader's turn runs: the follower joins it, the held message stays queued.
          const followerReleased = yield* watch(
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.type === "user_message" &&
              event.payload.messageId === follower!.userMessageId,
          );
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: providerTurnFor(started[1]!, yield* DateTime.now),
          });
          const followerEvent = yield* Fiber.join(followerReleased);
          yield* worker.drain();
          assert.deepEqual(steered, ["follower"]);
          // A batch member really was queued first, unlike a windowed steer.
          assert.equal(
            followerEvent.type === "turn-item.updated" &&
              followerEvent.payload.type === "user_message"
              ? followerEvent.payload.inputIntent
              : null,
            "promoted_queued_to_steer",
          );
          const stillHeld = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === held!.id,
          );
          assert.equal(stillHeld?.status, "queued");
          assert.equal(stillHeld?.queueBatchLeaderRunId, leader!.id);

          // The edit ends and the provider reports token usage on the same turn:
          // the batch was already released, so the message waits for its own turn.
          yield* hold("release", held!.id, false);
          const usageNow = yield* DateTime.now;
          const usageRecorded = yield* watch(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.runAttemptId === started[1]!.attemptId &&
              event.payload.tokenUsage !== undefined,
          );
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              ...providerTurnFor(started[1]!, usageNow),
              tokenUsage: { usedTokens: 1_000, updatedAt: DateTime.formatIso(usageNow) },
            },
          });
          yield* Fiber.join(usageRecorded);
          const heldStarting = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === held!.id &&
              event.payload.status === "starting",
          );
          yield* endTurn(1);
          yield* Fiber.join(heldStarting);
          yield* worker.drain();
          assert.deepEqual(steered, ["follower"]);
          assert.equal(started[2]!.runId, held!.id);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

// Fork: deferred archive and worktree switch count runs created after the
// request as new work, not runs created after the requesting one. `older` is
// queued first and held for editing; `newer` is reordered ahead of it, so it
// runs first.
const reorderedQueue = (name: string) =>
  Effect.gen(function* () {
    const { started, threadId, setup, layer } = yield* scenario(name);
    const reordered = Effect.gen(function* () {
      const { orchestrator, worker, watch, send, hold, endTurn, endActiveTurn } = yield* setup;
      yield* send("older", "queue");
      yield* send("newer", "queue");
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs
        .filter((run) => run.status === "queued")
        .toSorted((left, right) => left.ordinal - right.ordinal);
      const [older, newer] = [queued[0]!.id, queued[1]!.id];
      // A started turn's run is ended only once the provider reports it running.
      const turnRunning = (index: number) =>
        watch(
          (event) =>
            event.type === "provider-turn.updated" &&
            event.payload.status === "running" &&
            event.payload.runAttemptId === queued[index]!.activeAttemptId,
        );
      yield* hold("hold-older", older, true);
      yield* orchestrator.dispatch({
        type: "queued-run.reorder",
        commandId: CommandId.make("reorder"),
        threadId,
        runId: newer,
        beforeRunId: older,
      });
      const newerRunning = yield* turnRunning(1);
      yield* endActiveTurn;
      yield* Fiber.join(newerRunning);
      assert.equal(started[1]!.runId, newer);
      const releaseOlder = Effect.gen(function* () {
        const olderRunning = yield* turnRunning(0);
        yield* hold("release-older", older, false);
        yield* worker.drain();
        yield* Fiber.join(olderRunning);
        assert.equal(started[2]!.runId, older);
      });
      return { orchestrator, endTurn, releaseOlder };
    });
    return { threadId, layer, reordered };
  });

const switchStatus = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  requestId: string,
) =>
  Effect.gen(function* () {
    // An error outcome stands in for the resolved target, so the checkout stays put.
    yield* orchestrator.dispatch({
      type: "thread.worktree-switch.execute",
      commandId: CommandId.make(`${requestId}-execute`),
      threadId,
      requestId: CommandId.make(requestId),
      error: "Recorded by the test.",
    });
    return (yield* orchestrator.getThreadProjection(threadId)).thread.worktreeSwitch;
  });

it.effect("a worktree switch follows run start order through a reordered queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { threadId, layer, reordered } = yield* reorderedQueue("switch-start-order");
      yield* Effect.gen(function* () {
        const { orchestrator, endTurn, releaseOlder } = yield* reordered;
        const schedule = (commandId: string) =>
          orchestrator.dispatch({
            type: "thread.worktree-switch.schedule",
            commandId: CommandId.make(commandId),
            threadId,
            targetPath: "/elsewhere",
          });
        // `newer` asks while the older message is held: it would start in the old checkout.
        yield* schedule("switch-from-newer");
        const fromNewer = yield* switchStatus(orchestrator, threadId, "switch-from-newer");
        assert.equal(fromNewer?.status, "cancelled");
        assert.equal(fromNewer?.detail, WORKTREE_SWITCH_DETAIL.newWork);
        yield* endTurn(1);
        yield* releaseOlder;

        // `older` asks after `newer` ran: that earlier run is no new work.
        yield* schedule("switch-from-older");
        yield* endTurn(2);
        const fromOlder = yield* switchStatus(orchestrator, threadId, "switch-from-older");
        assert.equal(fromOlder?.status, "error");
        assert.equal(fromOlder?.detail, "Recorded by the test.");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("a deferred archive waits on its run past a reordered earlier run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { threadId, layer, reordered } = yield* reorderedQueue("archive-start-order");
      yield* Effect.gen(function* () {
        const { orchestrator, endTurn, releaseOlder } = yield* reordered;
        yield* endTurn(1);
        yield* releaseOlder;
        yield* orchestrator.dispatch({
          type: "thread.archive.schedule",
          commandId: CommandId.make("archive"),
          threadId,
          afterTurn: true,
        });
        yield* endTurn(2);
        yield* orchestrator.dispatch({
          type: "thread.archive.execute",
          commandId: CommandId.make("archive-execute"),
          threadId,
          requestId: CommandId.make("archive"),
        });
        const thread = (yield* orchestrator.getThreadProjection(threadId)).thread;
        assert.isNotNull(thread.archivedAt);
        assert.equal(thread.archiveRequest?.status, "completed");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("a message steered into the requesting run cancels a pending worktree switch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, threadId, setup, layer } = yield* scenario("switch-steer");
      yield* Effect.gen(function* () {
        const { orchestrator, worker } = yield* setup;
        yield* orchestrator.dispatch({
          type: "thread.worktree-switch.schedule",
          commandId: CommandId.make("switch"),
          threadId,
          targetPath: "/elsewhere",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "steer",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        assert.deepEqual(steered, ["steer"]);
        const request = (yield* orchestrator.getThreadProjection(threadId)).thread.worktreeSwitch;
        assert.equal(request?.status, "cancelled");
        assert.equal(request?.detail, WORKTREE_SWITCH_DETAIL.newWork);
      }).pipe(Effect.provide(layer));
    }),
  ),
);
