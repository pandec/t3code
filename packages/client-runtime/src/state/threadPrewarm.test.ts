import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import { withEnvironmentCacheMutationLock } from "../platform/environmentCacheMutationLock.ts";
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
  threadPrewarmRunGateLayer,
  ThreadHistoryWindow,
  ThreadPrewarmRunGate,
  ThreadPrewarmTriggers,
  ThreadSnapshotLoader,
  type ThreadSnapshotLoadWindow,
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
const TEST_HISTORY_WINDOW = ThreadHistoryWindow.of({
  messageWindowLimit: 150,
  messageOlderPageSize: 100,
  initialTurnLimit: 10,
  olderTurnLimit: 20,
  residentMessageCeiling: 750,
});

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

function retainedFixtureSnapshot(protocol: "turn" | "legacy"): OrchestrationThreadDetailSnapshot {
  const snapshot = detailSnapshot(`thread-${protocol}`, 10);
  const messages = Array.from({ length: 3 }, (_, index) => ({
    id: MessageId.make(`message-${index}`),
    role: "user" as const,
    text: `Message ${index}`,
    // Production user messages are anchors through projection_turns and do not
    // carry their turn id in the message shape.
    turnId: null,
    streaming: false,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  }));
  const activities = Array.from({ length: 501 }, (_, index) => ({
    id: EventId.make(`activity-${index}`),
    tone: "tool" as const,
    kind: "command",
    summary: `Ran command ${index}`,
    payload: {},
    turnId: TurnId.make(`turn-${index % messages.length}`),
    sequence: index,
    createdAt: "2026-04-01T00:00:00.000Z",
  }));
  return {
    ...snapshot,
    ...(protocol === "turn"
      ? {
          page: {
            beforeCursor: "cursor-1",
            hasMore: false,
            snapshotSequence: 10,
            threadSequence: 10,
          },
        }
      : {}),
    thread: {
      ...snapshot.thread,
      messages,
      activities,
      ...(protocol === "legacy"
        ? {
            messageWindow: {
              hasMoreOlder: true,
              oldestLoadedMessageId: messages[0]!.id,
              totalCount: 10,
            },
          }
        : {}),
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
  const saveCalls = yield* Ref.make<ReadonlyArray<OrchestrationThreadDetailSnapshot>>([]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(options.shell),
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      Ref.get(stored).pipe(Effect.map((map) => Option.fromNullishOr(map.get(threadId)))),
    saveThread: (_environmentId, snapshot) =>
      Ref.update(saveCalls, (calls) => [...calls, snapshot]).pipe(
        Effect.andThen(Ref.update(stored, (map) => new Map(map).set(snapshot.thread.id, snapshot))),
      ),
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  return { cache, stored, saveCalls };
});

function withoutStoredThread(
  map: ReadonlyMap<string, OrchestrationThreadDetailSnapshot>,
  threadId: string,
): ReadonlyMap<string, OrchestrationThreadDetailSnapshot> {
  const next = new Map(map);
  next.delete(threadId);
  return next;
}

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
  it.effect("only populates missing cache entries", () =>
    Effect.gen(function* () {
      const existing = detailSnapshot("thread-existing", 5);
      const missing = detailSnapshot("thread-missing", 8);
      const { cache, stored, saveCalls } = yield* makeCacheStore({
        shell: Option.none(),
        threads: [existing],
      });

      expect(
        yield* commitPrewarmedThreadSnapshot(
          cache,
          ENVIRONMENT_ID,
          detailSnapshot("thread-existing", 8),
        ),
      ).toBe(false);
      expect((yield* Ref.get(stored)).get("thread-existing")).toEqual(existing);
      expect(yield* Ref.get(saveCalls)).toEqual([]);

      expect(yield* commitPrewarmedThreadSnapshot(cache, ENVIRONMENT_ID, missing)).toBe(true);
      expect((yield* Ref.get(stored)).get("thread-missing")).toEqual(missing);
      expect(yield* Ref.get(saveCalls)).toEqual([missing]);
    }),
  );

  it.effect("retains only legacy history and preserves protocol metadata", () =>
    Effect.gen(function* () {
      const { cache, stored } = yield* makeCacheStore({ shell: Option.none() });

      expect(
        yield* commitPrewarmedThreadSnapshot(
          cache,
          ENVIRONMENT_ID,
          retainedFixtureSnapshot("turn"),
          2,
        ),
      ).toBe(true);
      expect(
        yield* commitPrewarmedThreadSnapshot(
          cache,
          ENVIRONMENT_ID,
          retainedFixtureSnapshot("legacy"),
          2,
        ),
      ).toBe(true);

      const turn = (yield* Ref.get(stored)).get("thread-turn");
      expect(turn?.thread.activities).toHaveLength(501);
      expect(turn?.thread.messages).toHaveLength(3);
      expect(turn?.page).toEqual({
        beforeCursor: "cursor-1",
        hasMore: false,
        snapshotSequence: 10,
        threadSequence: 10,
      });
      expect(turn?.thread.messageWindow).toBeUndefined();

      const legacy = (yield* Ref.get(stored)).get("thread-legacy");
      expect(legacy?.thread.activities).toHaveLength(500);
      expect(legacy?.thread.messages.map((message) => message.id)).toEqual([
        "message-1",
        "message-2",
      ]);
      expect(legacy?.page).toBeUndefined();
      expect(legacy?.thread.messageWindow).toEqual({
        hasMoreOlder: true,
        oldestLoadedMessageId: "message-1",
        totalCount: 10,
      });
    }),
  );

  it.effect("serializes missing-entry population with live persistence", () =>
    Effect.gen(function* () {
      const prewarm = detailSnapshot("thread-race", 110);
      const live = detailSnapshot("thread-race", 111);
      const stored = yield* Ref.make<Option.Option<OrchestrationThreadDetailSnapshot>>(
        Option.none(),
      );
      const prewarmLoaded = yield* Deferred.make<void>();
      const releasePrewarmLoad = yield* Deferred.make<void>();
      const saveOrder = yield* Ref.make<ReadonlyArray<number>>([]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () =>
          Deferred.succeed(prewarmLoaded, undefined).pipe(
            Effect.andThen(Deferred.await(releasePrewarmLoad)),
            Effect.andThen(Ref.get(stored)),
          ),
        saveThread: (_environmentId, snapshot) =>
          Ref.update(saveOrder, (order) => [...order, snapshot.snapshotSequence]).pipe(
            Effect.andThen(Ref.set(stored, Option.some(snapshot))),
          ),
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      const prewarmFiber = yield* commitPrewarmedThreadSnapshot(
        cache,
        ENVIRONMENT_ID,
        prewarm,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(prewarmLoaded);
      const liveFiber = yield* withEnvironmentCacheMutationLock(
        cache,
        ENVIRONMENT_ID,
        cache.saveThread(ENVIRONMENT_ID, live),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(saveOrder)).toEqual([]);

      yield* Deferred.succeed(releasePrewarmLoad, undefined);
      expect(yield* Fiber.join(prewarmFiber)).toBe(true);
      yield* Fiber.join(liveFiber);
      expect(yield* Ref.get(saveOrder)).toEqual([110, 111]);
      expect(Option.getOrThrow(yield* Ref.get(stored)).snapshotSequence).toBe(111);
    }),
  );
});

describe("thread prewarm run gate", () => {
  it.effect("runs at most one environment batch at a time", () =>
    Effect.gen(function* () {
      const gate = yield* ThreadPrewarmRunGate;
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);

      const first = yield* gate
        .run(
          Ref.update(order, (current) => [...current, "first"]).pipe(
            Effect.andThen(Deferred.succeed(firstStarted, undefined)),
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      const second = yield* gate
        .run(Ref.update(order, (current) => [...current, "second"]))
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      expect(yield* Ref.get(order)).toEqual(["first"]);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* Ref.get(order)).toEqual(["first", "second"]);
    }).pipe(Effect.provide(threadPrewarmRunGateLayer)),
  );
});

describe("makeEnvironmentThreadPrewarm", () => {
  const makeHarness = Effect.fn("TestThreadPrewarm.makeHarness")(function* (options?: {
    readonly initialPrepared?: Option.Option<PreparedConnection>;
    readonly cachedShell?: false;
    readonly fetchedSnapshot?: (threadId: string) => OrchestrationThreadDetailSnapshot;
    readonly hangSnapshotLoad?: boolean;
    readonly snapshotLoadStarted?: Deferred.Deferred<void>;
    readonly releaseSnapshotLoad?: Deferred.Deferred<void>;
    readonly paginationCapability?: boolean;
    readonly initialSession?: "none";
    readonly historyWindow?: ThreadHistoryWindow["Service"];
    readonly runGate?: ThreadPrewarmRunGate["Service"];
    readonly environmentId?: EnvironmentId;
  }) {
    const environmentId = options?.environmentId ?? ENVIRONMENT_ID;
    const target = new PrimaryConnectionTarget({
      environmentId,
      label: `Test environment ${environmentId}`,
      httpBaseUrl: `https://${environmentId}.example.test`,
      wsBaseUrl: `wss://${environmentId}.example.test`,
    });
    const preparedConnection: PreparedConnection = {
      environmentId,
      label: target.label,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: target.wsBaseUrl,
      httpAuthorization: null,
      target,
    };
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
    const { cache, stored, saveCalls } = yield* makeCacheStore({
      shell: options?.cachedShell === false ? Option.none() : Option.some(shell),
      // Existing entries are never fetched or replaced; "stale" is absent and
      // therefore exercises cold-cache population.
      threads: [detailSnapshot("current", 10)],
    });
    const loaderCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const loaderWindows = yield* Ref.make<ReadonlyArray<ThreadSnapshotLoadWindow | undefined>>([]);
    const loader = ThreadSnapshotLoader.of({
      load: (_prepared, threadId, window) =>
        Ref.update(loaderCalls, (calls) => [...calls, threadId]).pipe(
          Effect.andThen(Ref.update(loaderWindows, (windows) => [...windows, window])),
          Effect.andThen(
            options?.snapshotLoadStarted === undefined
              ? Effect.void
              : Deferred.succeed(options.snapshotLoadStarted, undefined),
          ),
          Effect.andThen(
            options?.releaseSnapshotLoad === undefined
              ? Effect.void
              : Deferred.await(options.releaseSnapshotLoad),
          ),
          Effect.andThen(
            options?.hangSnapshotLoad === true
              ? Effect.never
              : Effect.succeed(
                  Option.some(options?.fetchedSnapshot?.(threadId) ?? detailSnapshot(threadId, 10)),
                ),
          ),
        ),
    });
    const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
      AVAILABLE_CONNECTION_STATE,
    );
    const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      options?.initialPrepared ?? Option.some(preparedConnection),
    );
    const makeSession = (paginationCapability: boolean) =>
      ({
        initialConfig: Effect.succeed({
          threadSnapshotPagination: paginationCapability,
        } as never),
      }) as never;
    const session = yield* SubscriptionRef.make(
      options?.initialSession === "none"
        ? Option.none()
        : Option.some(makeSession(options?.paginationCapability === true)),
    );
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
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
      Effect.provideService(ThreadHistoryWindow, options?.historyWindow ?? TEST_HISTORY_WINDOW),
      Effect.provideService(
        ThreadPrewarmRunGate,
        options?.runGate ?? ThreadPrewarmRunGate.of({ run: (effect) => effect }),
      ),
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
      session,
      setSessionCapability: (supported: boolean) =>
        SubscriptionRef.set(session, Option.some(makeSession(supported))),
      wakeups,
      statuses,
      started,
      stored,
      saveCalls,
      loaderCalls,
      loaderWindows,
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

  it.effect("fetches and writes missing entries while skipping existing ones", () =>
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
        expect((yield* Ref.get(harness.saveCalls)).map((snapshot) => snapshot.thread.id)).toEqual([
          "stale",
        ]);
      }),
    ),
  );

  it.effect("requests a turn page when the server advertises pagination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ paginationCapability: true });

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.statuses);

        const windows = yield* Ref.get(harness.loaderWindows);
        expect(windows).toEqual([{ turnLimit: 10 }]);
        expect((yield* Ref.get(harness.saveCalls)).map((snapshot) => snapshot.thread.id)).toEqual([
          "stale",
        ]);
        expect(windows.some((window) => window !== undefined && "messageLimit" in window)).toBe(
          false,
        );
      }),
    ),
  );

  it.effect("falls back to only the legacy message window without the capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ paginationCapability: false });

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.statuses);

        const windows = yield* Ref.get(harness.loaderWindows);
        expect(windows).toEqual([{ messageLimit: 150 }]);
        expect(windows.some((window) => window !== undefined && "turnLimit" in window)).toBe(false);
      }),
    ),
  );

  it.effect("waits for a session before selecting the snapshot protocol", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ initialSession: "none" });

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.started);
        expect(yield* Ref.get(harness.loaderWindows)).toEqual([]);
        expect(Option.isNone(yield* Queue.poll(harness.statuses))).toBe(true);

        yield* harness.setSessionCapability(true);
        yield* Effect.yieldNow;
        expect((yield* Queue.take(harness.statuses)).refreshed).toBe(1);
        expect(yield* Ref.get(harness.loaderWindows)).toEqual([{ turnLimit: 10 }]);
      }),
    ),
  );

  it.effect("does not fail or consume cooldown when the session wait expires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ initialSession: "none" });

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.started);
        yield* TestClock.adjust("2 seconds");

        const skipped = yield* Queue.take(harness.statuses);
        expect(skipped.failed).toBe(0);
        expect(skipped.lastRunAt).toBe(null);
        expect(yield* Ref.get(harness.loaderCalls)).toEqual([]);

        yield* harness.setSessionCapability(true);
        yield* SubscriptionRef.set(harness.supervisorState, {
          ...CONNECTED_STATE,
          generation: 2,
        });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        expect((yield* Queue.take(harness.statuses)).refreshed).toBe(1);
        expect(yield* Ref.get(harness.loaderWindows)).toEqual([{ turnLimit: 10 }]);
      }),
    ),
  );

  it.effect("explicitly completes manual and settled triggers when session wait expires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manual = yield* makeHarness({
          environmentId: EnvironmentId.make("environment-manual-sessionless"),
          initialSession: "none",
        });
        const settled = yield* makeHarness({
          environmentId: EnvironmentId.make("environment-settled-sessionless"),
          initialSession: "none",
        });

        yield* manual.fire({ reason: "manual" });
        yield* settled.fire({
          reason: "thread-settled",
          environmentId: EnvironmentId.make("environment-settled-sessionless"),
          threadId: ThreadId.make("stale"),
        });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(manual.started);
        yield* Queue.take(settled.started);
        yield* TestClock.adjust("2 seconds");

        const manualStatus = yield* Queue.take(manual.statuses);
        const settledStatus = yield* Queue.take(settled.statuses);
        expect(manualStatus.running).toBe(false);
        expect(manualStatus.failed).toBe(1);
        expect(manualStatus.lastRunAt).toBe(null);
        expect(manualStatus.lastManualRequestCompletedAt).not.toBe(null);
        expect(settledStatus.running).toBe(false);
        expect(settledStatus.failed).toBe(1);
        expect(settledStatus.lastRunAt).toBe(null);
        expect(settledStatus.lastManualRequestCompletedAt).toBe(null);
        expect(yield* Ref.get(manual.loaderCalls)).toEqual([]);
        expect(yield* Ref.get(settled.loaderCalls)).toEqual([]);
      }),
    ),
  );

  it.effect("completes an offline manual request without claiming a successful sync", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          initialPrepared: Option.none(),
          initialSession: "none",
        });

        yield* harness.fire({ reason: "manual" });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        const status = yield* Queue.take(harness.statuses);
        expect(status.running).toBe(false);
        expect(status.failed).toBe(1);
        expect(status.lastRunAt).toBe(null);
        expect(status.lastManualRequestCompletedAt).not.toBe(null);
        expect(yield* Ref.get(harness.loaderCalls)).toEqual([]);
        expect(Option.isNone(yield* Queue.poll(harness.started))).toBe(true);
      }),
    ),
  );

  it.effect("does not occupy the shared gate while awaiting a session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runGate = yield* ThreadPrewarmRunGate;
        const waiting = yield* makeHarness({
          environmentId: EnvironmentId.make("environment-session-wait"),
          initialSession: "none",
          runGate,
        });
        const ready = yield* makeHarness({
          environmentId: EnvironmentId.make("environment-session-ready"),
          runGate,
        });

        yield* SubscriptionRef.set(waiting.supervisorState, CONNECTED_STATE);
        yield* SubscriptionRef.set(ready.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(waiting.started);
        yield* Queue.take(ready.started);

        expect((yield* Queue.take(ready.statuses)).refreshed).toBe(1);
        expect(yield* Ref.get(ready.loaderCalls)).toEqual(["stale"]);
        expect(yield* Ref.get(waiting.loaderCalls)).toEqual([]);
      }).pipe(Effect.provide(threadPrewarmRunGateLayer)),
    ),
  );

  it.effect("keeps web and desktop prewarm requests unbounded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          paginationCapability: true,
          historyWindow: ThreadHistoryWindow.of({
            messageWindowLimit: null,
            messageOlderPageSize: 200,
          }),
        });

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.statuses);

        expect(yield* Ref.get(harness.loaderWindows)).toEqual([undefined]);
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

  it.effect("reports a manual request with no cached shell as unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cachedShell: false });

        yield* harness.fire({ reason: "manual" });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        expect((yield* Queue.take(harness.started)).running).toBe(true);
        const status = yield* Queue.take(harness.statuses);
        expect(status.failed).toBe(1);
        expect(status.lastRunAt).toBe(null);
        expect(status.lastManualRequestCompletedAt).not.toBe(null);
      }),
    ),
  );

  it.effect("reports a timed-out run and suppresses an immediate reconnect retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ hangSnapshotLoad: true });

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.started);
        yield* TestClock.adjust("30 seconds");

        const timedOut = yield* Queue.take(harness.statuses);
        expect(timedOut.failed).toBe(1);
        expect(timedOut.lastRunAt).toBe(null);

        yield* SubscriptionRef.set(harness.supervisorState, {
          ...CONNECTED_STATE,
          generation: 2,
        });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        expect(Option.isNone(yield* Queue.poll(harness.started))).toBe(true);
        expect(Option.isNone(yield* Queue.poll(harness.statuses))).toBe(true);
      }),
    ),
  );

  it.effect("serializes real environment engines through the shared gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runGate = yield* ThreadPrewarmRunGate;
        const firstLoadStarted = yield* Deferred.make<void>();
        const releaseFirstLoad = yield* Deferred.make<void>();
        const first = yield* makeHarness({
          environmentId: EnvironmentId.make("environment-gate-1"),
          snapshotLoadStarted: firstLoadStarted,
          releaseSnapshotLoad: releaseFirstLoad,
          runGate,
        });
        const second = yield* makeHarness({
          environmentId: EnvironmentId.make("environment-gate-2"),
          runGate,
        });

        yield* SubscriptionRef.set(first.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(first.started);
        yield* Deferred.await(firstLoadStarted);

        yield* SubscriptionRef.set(second.supervisorState, CONNECTED_STATE);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(second.started);
        expect(yield* Ref.get(second.loaderCalls)).toEqual([]);

        yield* Deferred.succeed(releaseFirstLoad, undefined);
        expect((yield* Queue.take(first.statuses)).refreshed).toBe(1);
        expect((yield* Queue.take(second.statuses)).refreshed).toBe(1);
        expect(yield* Ref.get(first.loaderCalls)).toEqual(["stale"]);
        expect(yield* Ref.get(second.loaderCalls)).toEqual(["stale"]);
      }).pipe(Effect.provide(threadPrewarmRunGateLayer)),
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
        expect((yield* Ref.get(harness.stored)).has("stale")).toBe(false);
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
        yield* Ref.update(harness.stored, (map) => withoutStoredThread(map, "stale"));
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

        yield* Ref.update(harness.stored, (map) => withoutStoredThread(map, "stale"));
        yield* harness.fire({ reason: "manual" });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");

        const status = yield* Queue.take(harness.statuses);
        expect(status.refreshed).toBe(1);
        expect(status.skipped).toBe(1);
        expect(status.lastRunAt).not.toBe(null);
        expect(status.lastManualRequestCompletedAt).not.toBe(null);
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

        yield* Ref.update(harness.stored, (map) => withoutStoredThread(map, "stale"));
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
          new Map(withoutStoredThread(map, "stale")).set("current", detailSnapshot("current", 3)),
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
        lastManualRequestCompletedAt: 900,
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
    expect(summary.environmentLastManualRequestCompletedAt.get(ENVIRONMENT_ID)).toBe(900);
    expect(
      didEnvironmentPrewarmRunsAdvance(
        summary.environmentLastManualRequestCompletedAt,
        new Map([[ENVIRONMENT_ID, 900]]),
      ),
    ).toBe(false);
  });

  it("completes an offline request without advancing the successful-sync timestamp", () => {
    const harness = makeHarness();
    harness.registry.set(
      harness.statusAtoms(ENVIRONMENT_ID),
      AsyncResult.success<EnvironmentThreadPrewarmStatus>({
        ...EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
        lastManualRequestCompletedAt: 1_000,
        failed: 1,
      }),
    );

    const summary = harness.registry.get(harness.summaryAtom);
    expect(summary.lastRunAt).toBe(null);
    expect(summary.environmentLastRunAt.get(ENVIRONMENT_ID)).toBe(null);
    expect(
      didEnvironmentPrewarmRunsAdvance(
        summary.environmentLastManualRequestCompletedAt,
        new Map([[ENVIRONMENT_ID, null]]),
      ),
    ).toBe(true);
  });

  it("does not treat a background run as manual request completion", () => {
    const harness = makeHarness();
    harness.registry.set(
      harness.statusAtoms(ENVIRONMENT_ID),
      AsyncResult.success<EnvironmentThreadPrewarmStatus>({
        ...EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
        lastRunAt: 1_000,
      }),
    );

    const summary = harness.registry.get(harness.summaryAtom);
    expect(summary.lastRunAt).toBe(1_000);
    expect(
      didEnvironmentPrewarmRunsAdvance(
        summary.environmentLastManualRequestCompletedAt,
        new Map([[ENVIRONMENT_ID, null]]),
      ),
    ).toBe(false);
  });
});
