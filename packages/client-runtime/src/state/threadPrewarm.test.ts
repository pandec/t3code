import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  advanceThreadStreamingSnapshot,
  commitPrewarmedThreadSnapshot,
  createThreadPrewarmSummaryAtom,
  didEnvironmentPrewarmRunsAdvance,
  EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
  makeEnvironmentThreadPrewarm,
  seedThreadStreamingSnapshot,
  selectPrewarmCandidates,
  ThreadPrewarmTriggers,
  ThreadSnapshotLoader,
  type EnvironmentThreadPrewarmStatus,
  type ThreadPrewarmTriggerRequest,
} from "./threads.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const PREPARED: PreparedConnection = {
  environmentId: ENVIRONMENT_ID,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const CONNECTED_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "connected",
  generation: 1,
};

function threadShell(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: `Thread ${id}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function runningSession(threadId: string) {
  return {
    threadId: ThreadId.make(threadId),
    status: "running" as const,
    providerName: "codex",
    runtimeMode: "full-access" as const,
    activeTurnId: TurnId.make("turn-1"),
    lastError: null,
    updatedAt: "2026-04-01T00:01:00.000Z",
  };
}

function detailSnapshot(id: string, snapshotSequence: number): OrchestrationThreadDetailSnapshot {
  const shell = threadShell(id);
  return {
    snapshotSequence,
    thread: {
      ...shell,
      completedTurnAssistantMessageIds: [],
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    },
  };
}

const makeCacheStore = Effect.fn("TestThreadPrewarm.makeCacheStore")(function* (options: {
  readonly shell: Option.Option<OrchestrationShellSnapshot>;
  readonly threads?: ReadonlyArray<OrchestrationThreadDetailSnapshot>;
}) {
  const stored = yield* Ref.make<ReadonlyMap<string, OrchestrationThreadDetailSnapshot>>(
    new Map((options.threads ?? []).map((snapshot) => [snapshot.thread.id, snapshot])),
  );
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(options.shell),
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      Ref.get(stored).pipe(Effect.map((map) => Option.fromNullishOr(map.get(threadId)))),
    saveThread: (_environmentId, snapshot) =>
      Ref.update(stored, (map) => new Map(map).set(snapshot.thread.id, snapshot)),
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  return { cache, stored };
});

describe("selectPrewarmCandidates", () => {
  it("prefers recently updated threads and drops archived and streaming ones", () => {
    const threads = [
      threadShell("old", { updatedAt: "2026-04-01T00:00:00.000Z" }),
      threadShell("archived", {
        updatedAt: "2026-04-05T00:00:00.000Z",
        archivedAt: "2026-04-05T00:00:00.000Z",
      }),
      threadShell("streaming", {
        updatedAt: "2026-04-06T00:00:00.000Z",
        session: runningSession("streaming"),
      }),
      threadShell("newest", { updatedAt: "2026-04-04T00:00:00.000Z" }),
      threadShell("newer", { updatedAt: "2026-04-03T00:00:00.000Z" }),
    ];

    expect(selectPrewarmCandidates(threads, 2).map((thread) => thread.id)).toEqual([
      "newest",
      "newer",
    ]);
  });
});

describe("commitPrewarmedThreadSnapshot", () => {
  it.effect("writes newer snapshots and rejects equal or older ones", () =>
    Effect.gen(function* () {
      const { cache, stored } = yield* makeCacheStore({
        shell: Option.none(),
        threads: [detailSnapshot("thread-1", 5)],
      });

      expect(
        yield* commitPrewarmedThreadSnapshot(cache, ENVIRONMENT_ID, detailSnapshot("thread-1", 4)),
      ).toBe(false);
      expect((yield* Ref.get(stored)).get("thread-1")?.snapshotSequence).toBe(5);

      expect(
        yield* commitPrewarmedThreadSnapshot(cache, ENVIRONMENT_ID, detailSnapshot("thread-1", 5)),
      ).toBe(false);
      expect(
        yield* commitPrewarmedThreadSnapshot(cache, ENVIRONMENT_ID, detailSnapshot("thread-1", 8)),
      ).toBe(true);
      expect((yield* Ref.get(stored)).get("thread-1")?.snapshotSequence).toBe(8);
    }),
  );
});

describe("makeEnvironmentThreadPrewarm", () => {
  const makeHarness = Effect.fn("TestThreadPrewarm.makeHarness")(function* (options?: {
    readonly initialPrepared?: Option.Option<PreparedConnection>;
    readonly cachedShell?: false;
    readonly fetchedSnapshot?: (threadId: string) => OrchestrationThreadDetailSnapshot;
  }) {
    const shell: OrchestrationShellSnapshot = {
      snapshotSequence: 10,
      projects: [],
      threads: [
        threadShell("stale", { updatedAt: "2026-04-04T00:00:00.000Z" }),
        threadShell("current", { updatedAt: "2026-04-03T00:00:00.000Z" }),
        threadShell("streaming", {
          updatedAt: "2026-04-06T00:00:00.000Z",
          session: runningSession("streaming"),
        }),
      ],
      updatedAt: "2026-04-06T00:00:00.000Z",
    };
    const { cache, stored } = yield* makeCacheStore({
      shell: options?.cachedShell === false ? Option.none() : Option.some(shell),
      // "current" already sits at the shell's cursor, so it must be skipped
      // without a fetch; "stale" is behind it and must be refreshed.
      threads: [detailSnapshot("current", 10), detailSnapshot("stale", 3)],
    });
    const loaderCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const loader = ThreadSnapshotLoader.of({
      load: (_prepared, threadId) =>
        Ref.update(loaderCalls, (calls) => [...calls, threadId]).pipe(
          Effect.as(
            Option.some(options?.fetchedSnapshot?.(threadId) ?? detailSnapshot(threadId, 10)),
          ),
        ),
    });
    const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
      AVAILABLE_CONNECTION_STATE,
    );
    const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      options?.initialPrepared ?? Option.some(PREPARED),
    );
    const session = yield* SubscriptionRef.make(Option.none());
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: supervisorState,
      session,
      prepared,
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
    const triggerRequests = yield* Queue.unbounded<ThreadPrewarmTriggerRequest>();
    const statuses = yield* Queue.unbounded<EnvironmentThreadPrewarmStatus>();
    // In-flight events are split off so every completion assertion below reads
    // the settled status without stepping over the run's opening event.
    const started = yield* Queue.unbounded<EnvironmentThreadPrewarmStatus>();

    const stream = yield* makeEnvironmentThreadPrewarm().pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      Effect.provideService(ThreadSnapshotLoader, loader),
      Effect.provideService(
        ConnectionWakeups.ConnectionWakeups,
        ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
      ),
      Effect.provideService(
        ThreadPrewarmTriggers,
        ThreadPrewarmTriggers.of({
          changes: Stream.fromQueue(triggerRequests),
          fire: (request) => Queue.offer(triggerRequests, request).pipe(Effect.asVoid),
        }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(stream, (status) =>
        Queue.offer(status.running ? started : statuses, status),
      ),
    );
    const initialStatus = yield* Queue.take(statuses);

    const fire = (request: ThreadPrewarmTriggerRequest) => Queue.offer(triggerRequests, request);

    return {
      supervisorState,
      prepared,
      wakeups,
      statuses,
      started,
      stored,
      loaderCalls,
      initialStatus,
      fire,
    };
  });

  it.effect("establishes a settled baseline whenever the stream starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        // The environment registry can replace a supervisor by interrupting
        // this stream and executing it again. Its first event must clear a
        // retained in-flight status even before the replacement runs.
        expect(harness.initialStatus).toEqual(EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS);
      }),
    ),
  );

  it.effect("warms stale recent threads once the environment connects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        const status = yield* Queue.take(harness.statuses);
        expect(status.refreshed).toBe(1);
        expect(status.skipped).toBe(1);
        expect(status.failed).toBe(0);
        expect(yield* Ref.get(harness.loaderCalls)).toEqual(["stale"]);
        expect((yield* Ref.get(harness.stored)).get("stale")?.snapshotSequence).toBe(10);
      }),
    ),
  );

  it.effect("announces a run in flight before reporting its counts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        // The opening event carries the previous run's counts — there is no
        // previous run here, so they are empty rather than the run's own.
        const started = yield* Queue.take(harness.started);
        expect(started.running).toBe(true);
        expect(started.lastRunAt).toBe(null);
        expect(started.refreshed).toBe(0);

        const status = yield* Queue.take(harness.statuses);
        expect(status.running).toBe(false);
        expect(status.refreshed).toBe(1);

        // A second run reports the first run's outcome while it is in flight,
        // so a "last synced" surface never blanks mid-sync.
        yield* TestClock.adjust("60 seconds");
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        const restarted = yield* Queue.take(harness.started);
        expect(restarted.running).toBe(true);
        expect(restarted.lastRunAt).toBe(status.lastRunAt);
        expect(restarted.refreshed).toBe(1);
      }),
    ),
  );

  it.effect("closes an announced run that produced no result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cachedShell: false });

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        // The run was committed to before it discovered there was no cached
        // shell to warm from. It still has to clear its own in-flight event,
        // and must not claim a run it never completed.
        expect((yield* Queue.take(harness.started)).running).toBe(true);
        const status = yield* Queue.take(harness.statuses);
        expect(status.running).toBe(false);
        expect(status.lastRunAt).toBe(null);
      }),
    ),
  );

  it.effect("does not announce a run when the batch has nothing to do", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.started);
        yield* Queue.take(harness.statuses);

        // Suppressed by the cooldown: no work, so no in-flight event either.
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        expect(Option.isNone(yield* Queue.poll(harness.started))).toBe(true);
        expect(Option.isNone(yield* Queue.poll(harness.statuses))).toBe(true);
      }),
    ),
  );

  it.effect("does not cool down a no-op foreground attempt before connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ initialPrepared: Option.none() });

        yield* Queue.offer(harness.wakeups, "application-active");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        expect(Option.isNone(yield* Queue.poll(harness.statuses))).toBe(true);
        // An unconnected environment does no work, so it must not announce a
        // run either.
        expect(Option.isNone(yield* Queue.poll(harness.started))).toBe(true);

        yield* SubscriptionRef.set(harness.prepared, Option.some(PREPARED));
        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        const status = yield* Queue.take(harness.statuses);
        expect(status.refreshed).toBe(1);
        expect(status.skipped).toBe(1);
      }),
    ),
  );

  it.effect("does not persist a fetched snapshot that became actively streaming", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          fetchedSnapshot: (threadId) => {
            const snapshot = detailSnapshot(threadId, 10);
            return {
              ...snapshot,
              thread: {
                ...snapshot.thread,
                session: runningSession(threadId),
              },
            };
          },
        });

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        const status = yield* Queue.take(harness.statuses);
        expect(status.refreshed).toBe(0);
        expect(status.skipped).toBe(2);
        expect((yield* Ref.get(harness.stored)).get("stale")?.snapshotSequence).toBe(3);
      }),
    ),
  );

  it.effect("applies a cooldown between runs and rewarms after it elapses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.statuses);

        // A foreground wakeup right after the first run stays within the
        // cooldown and must not trigger another warm pass.
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        expect(Option.isNone(yield* Queue.poll(harness.statuses))).toBe(true);

        yield* TestClock.adjust("60 seconds");
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        const status = yield* Queue.take(harness.statuses);
        expect(status.skipped).toBe(2);
      }),
    ),
  );

  it.effect("warms only a settled thread despite the cooldown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.statuses);

        // The turn that just settled produced events the cached detail does
        // not have yet.
        yield* Ref.update(harness.stored, (map) =>
          new Map(map).set("stale", detailSnapshot("stale", 3)),
        );
        yield* harness.fire({
          reason: "thread-settled",
          environmentId: ENVIRONMENT_ID,
          threadId: ThreadId.make("stale"),
        });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        const status = yield* Queue.take(harness.statuses);
        expect(status.refreshed).toBe(1);
        expect(status.skipped).toBe(0);
        expect(yield* Ref.get(harness.loaderCalls)).toEqual(["stale", "stale"]);
        expect((yield* Ref.get(harness.stored)).get("stale")?.snapshotSequence).toBe(10);
      }),
    ),
  );

  it.effect("ignores settle triggers for other environments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.statuses);

        yield* harness.fire({
          reason: "thread-settled",
          environmentId: EnvironmentId.make("environment-2"),
          threadId: ThreadId.make("stale"),
        });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        expect(Option.isNone(yield* Queue.poll(harness.statuses))).toBe(true);
      }),
    ),
  );

  it.effect("runs a full manual warm without extending the lifecycle cooldown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.statuses);

        yield* Ref.update(harness.stored, (map) =>
          new Map(map).set("stale", detailSnapshot("stale", 3)),
        );
        yield* harness.fire({ reason: "manual" });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        const status = yield* Queue.take(harness.statuses);
        expect(status.refreshed).toBe(1);
        expect(status.skipped).toBe(1);
        expect(yield* Ref.get(harness.loaderCalls)).toEqual(["stale", "stale"]);

        // The manual run completed three seconds after the lifecycle run. A
        // lifecycle trigger that drains exactly 60 seconds after the original
        // run must still proceed; if manual sync consumed the cooldown it
        // would remain suppressed for another three seconds.
        yield* TestClock.adjust("54 seconds");
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        expect((yield* Queue.take(harness.statuses)).skipped).toBe(2);
      }),
    ),
  );

  it.effect("stays full when a cooling lifecycle trigger joins a manual batch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.statuses);

        yield* Ref.update(harness.stored, (map) =>
          new Map(map).set("stale", detailSnapshot("stale", 3)),
        );
        // A foreground wakeup lands in the same batch as the manual request
        // while the cooldown is still active: the run must stay full (manual
        // wins over the targeted path) without the suppressed lifecycle
        // trigger consuming the cooldown.
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* harness.fire({ reason: "manual" });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        const status = yield* Queue.take(harness.statuses);
        expect(status.refreshed).toBe(1);
        expect(status.skipped).toBe(1);
        expect(yield* Ref.get(harness.loaderCalls)).toEqual(["stale", "stale"]);

        // Cooldown still dates from the original lifecycle run: a wakeup
        // draining exactly 60 seconds after it must sweep again.
        yield* TestClock.adjust("54 seconds");
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        expect((yield* Queue.take(harness.statuses)).skipped).toBe(2);
      }),
    ),
  );

  it.effect("keeps a settled target when a cooling lifecycle trigger joins its batch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.statuses);

        yield* Ref.update(harness.stored, (map) =>
          new Map(map)
            .set("stale", detailSnapshot("stale", 3))
            .set("current", detailSnapshot("current", 3)),
        );
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* harness.fire({
          reason: "thread-settled",
          environmentId: ENVIRONMENT_ID,
          threadId: ThreadId.make("stale"),
        });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        const status = yield* Queue.take(harness.statuses);
        expect(status.refreshed).toBe(1);
        expect(status.skipped).toBe(0);
        expect(yield* Ref.get(harness.loaderCalls)).toEqual(["stale", "stale"]);
        expect((yield* Ref.get(harness.stored)).get("current")?.snapshotSequence).toBe(3);
      }),
    ),
  );
});

describe("manual prewarm completion", () => {
  const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-2");

  it("waits for every requested environment without comparing wall clocks", () => {
    const requestedFrom = new Map([
      [ENVIRONMENT_ID, 100],
      [OTHER_ENVIRONMENT_ID, null],
    ]);

    expect(
      didEnvironmentPrewarmRunsAdvance(
        new Map([
          [ENVIRONMENT_ID, 90],
          [OTHER_ENVIRONMENT_ID, null],
        ]),
        requestedFrom,
      ),
    ).toBe(false);
    expect(
      didEnvironmentPrewarmRunsAdvance(
        new Map([
          [ENVIRONMENT_ID, 90],
          [OTHER_ENVIRONMENT_ID, 50],
        ]),
        requestedFrom,
      ),
    ).toBe(true);
  });

  it("does not wait for an environment removed after the request", () => {
    expect(
      didEnvironmentPrewarmRunsAdvance(
        new Map([[ENVIRONMENT_ID, 200]]),
        new Map([
          [ENVIRONMENT_ID, 100],
          [OTHER_ENVIRONMENT_ID, null],
        ]),
      ),
    ).toBe(true);
  });
});

describe("thread streaming snapshots", () => {
  const streamingShell = (id: string, overrides: Partial<OrchestrationThreadShell> = {}) => ({
    environmentId: ENVIRONMENT_ID,
    ...threadShell(id, overrides),
  });

  it("emits a settled thread once when its session leaves the streaming states", () => {
    const streaming = [streamingShell("thread-1", { session: runningSession("thread-1") })];
    const idle = [streamingShell("thread-1")];

    const seeded = seedThreadStreamingSnapshot(streaming);
    const first = advanceThreadStreamingSnapshot(seeded, idle);
    expect(first.settled).toEqual([{ environmentId: ENVIRONMENT_ID, threadId: "thread-1" }]);

    const second = advanceThreadStreamingSnapshot(first.snapshot, idle);
    expect(second.settled).toEqual([]);
  });

  it("stays silent for new, still-streaming, and archived threads", () => {
    const seeded = seedThreadStreamingSnapshot([
      streamingShell("streaming", { session: runningSession("streaming") }),
      streamingShell("archived", { session: runningSession("archived") }),
    ]);
    const { settled } = advanceThreadStreamingSnapshot(seeded, [
      streamingShell("streaming", { session: runningSession("streaming") }),
      streamingShell("archived", { archivedAt: "2026-04-06T00:00:00.000Z" }),
      streamingShell("new-idle"),
    ]);
    expect(settled).toEqual([]);
  });
});

describe("createThreadPrewarmSummaryAtom", () => {
  const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-2");

  function environmentEntry(environmentId: EnvironmentId) {
    return {
      target: new PrimaryConnectionTarget({
        environmentId,
        label: environmentId,
        httpBaseUrl: `https://${environmentId}.example.test`,
        wsBaseUrl: `wss://${environmentId}.example.test`,
      }),
      profile: Option.none(),
    };
  }

  function makeHarness() {
    const statusAtoms = Atom.family((_environmentId: EnvironmentId) =>
      Atom.make(
        AsyncResult.success<EnvironmentThreadPrewarmStatus>(
          EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
        ),
      ),
    );
    const summaryAtom = createThreadPrewarmSummaryAtom({
      catalogValueAtom: Atom.make({
        isReady: true,
        entries: new Map([
          [ENVIRONMENT_ID, environmentEntry(ENVIRONMENT_ID)],
          [OTHER_ENVIRONMENT_ID, environmentEntry(OTHER_ENVIRONMENT_ID)],
        ]),
      }),
      statusAtom: statusAtoms,
    });
    return { registry: AtomRegistry.make(), statusAtoms, summaryAtom };
  }

  it("reports syncing while any environment has a run in flight", () => {
    const harness = makeHarness();
    expect(harness.registry.get(harness.summaryAtom).syncing).toBe(false);

    harness.registry.set(
      harness.statusAtoms(OTHER_ENVIRONMENT_ID),
      AsyncResult.success<EnvironmentThreadPrewarmStatus>({
        ...EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
        running: true,
      }),
    );
    expect(harness.registry.get(harness.summaryAtom).syncing).toBe(true);
  });

  it("keeps a completed run's cursor when a stream restart re-emits the baseline", () => {
    const harness = makeHarness();
    harness.registry.set(
      harness.statusAtoms(ENVIRONMENT_ID),
      AsyncResult.success<EnvironmentThreadPrewarmStatus>({
        lastRunAt: 1_000,
        refreshed: 2,
        skipped: 0,
        failed: 0,
        running: false,
      }),
    );
    expect(harness.registry.get(harness.summaryAtom).lastRunAt).toBe(1_000);

    // A catalog entry change restarts the stream, whose first event is the
    // empty baseline. It exists to clear a stranded `running`, and must not
    // roll "last synced" back to never — a pending manual sync reads this
    // cursor to decide whether its own run has completed.
    harness.registry.set(
      harness.statusAtoms(ENVIRONMENT_ID),
      AsyncResult.success<EnvironmentThreadPrewarmStatus>(EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS),
    );
    const summary = harness.registry.get(harness.summaryAtom);
    expect(summary.lastRunAt).toBe(1_000);
    expect(summary.environmentLastRunAt.get(ENVIRONMENT_ID)).toBe(1_000);
    expect(
      didEnvironmentPrewarmRunsAdvance(
        summary.environmentLastRunAt,
        new Map([[ENVIRONMENT_ID, 1_000]]),
      ),
    ).toBe(false);
  });
});
