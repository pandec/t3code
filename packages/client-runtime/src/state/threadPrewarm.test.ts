import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type * as RpcSession from "../rpc/session.ts";
import { v2Projection, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  advanceThreadActivitySnapshot,
  commitPrewarmedThreadSnapshot,
  didEnvironmentPrewarmRunsAdvance,
  EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
  makeEnvironmentThreadPrewarm,
  seedThreadActivitySnapshot,
  selectPrewarmCandidates,
  ThreadPrewarmTriggers,
  ThreadSnapshotLoader,
  type EnvironmentThreadPrewarmStatus,
  type ThreadPrewarmTriggerRequest,
  type ThreadSnapshotLoadResult,
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

function shell(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return { ...v2ThreadShell, id: ThreadId.make(id), ...overrides };
}

function at(iso: string) {
  return DateTime.makeUnsafe(iso);
}

function projection(id: string, active = false): OrchestrationV2ThreadProjection {
  return {
    ...v2Projection,
    thread: { ...v2Projection.thread, id: ThreadId.make(id) },
    runs: active
      ? [
          {
            id: RunId.make(`run-${id}`),
            threadId: ThreadId.make(id),
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: v2ThreadShell.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`message-${id}`),
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: v2Projection.updatedAt,
            startedAt: v2Projection.updatedAt,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ]
      : [],
  };
}

function detail(id: string, snapshotSequence: number): OrchestrationV2ThreadDetailSnapshot {
  return { snapshotSequence, projection: projection(id) };
}

const makeCache = Effect.fn("TestThreadPrewarm.makeCache")(function* (options: {
  readonly shell: Option.Option<OrchestrationV2ShellSnapshot>;
  readonly threads?: ReadonlyArray<OrchestrationV2ThreadDetailSnapshot>;
  readonly failThreadRead?: string;
}) {
  const stored = yield* Ref.make<ReadonlyMap<string, OrchestrationV2ThreadDetailSnapshot>>(
    new Map((options.threads ?? []).map((snapshot) => [snapshot.projection.thread.id, snapshot])),
  );
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(options.shell),
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      options.failThreadRead === threadId
        ? Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "load-thread",
              message: "read failure",
            }),
          )
        : Ref.get(stored).pipe(Effect.map((map) => Option.fromNullishOr(map.get(threadId)))),
    saveThread: (_environmentId, snapshot) =>
      Ref.update(stored, (map) => new Map(map).set(snapshot.projection.thread.id, snapshot)),
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  return { cache, stored };
});

describe("selectPrewarmCandidates", () => {
  it("ranks recently updated threads and drops archived, subagent and running ones", () => {
    const threads = [
      shell("old", { updatedAt: at("2026-06-01T00:00:00.000Z") }),
      shell("archived", {
        updatedAt: at("2026-06-05T00:00:00.000Z"),
        archivedAt: at("2026-06-05T00:00:00.000Z"),
      }),
      shell("subagent", {
        updatedAt: at("2026-06-07T00:00:00.000Z"),
        lineage: {
          rootThreadId: ThreadId.make("newest"),
          parentThreadId: ThreadId.make("newest"),
          relationshipToParent: "subagent",
        },
      }),
      shell("running", { updatedAt: at("2026-06-06T00:00:00.000Z"), status: "running" }),
      shell("newest", { updatedAt: at("2026-06-04T00:00:00.000Z") }),
      shell("waiting", { updatedAt: at("2026-06-03T00:00:00.000Z"), status: "waiting" }),
    ];

    expect(selectPrewarmCandidates(threads, 2)).toEqual(["newest", "waiting"]);
  });
});

describe("commitPrewarmedThreadSnapshot", () => {
  it.effect("only populates missing entries and fails closed on read errors", () =>
    Effect.gen(function* () {
      const existing = detail("existing", 5);
      const { cache, stored } = yield* makeCache({
        shell: Option.none(),
        threads: [existing],
        failThreadRead: "unreadable",
      });

      expect(
        yield* commitPrewarmedThreadSnapshot(cache, ENVIRONMENT_ID, detail("existing", 9)),
      ).toBe("existing");
      expect((yield* Ref.get(stored)).get("existing")).toEqual(existing);
      expect(
        yield* commitPrewarmedThreadSnapshot(cache, ENVIRONMENT_ID, detail("unreadable", 9)),
      ).toBe("failed");
      expect((yield* Ref.get(stored)).has("unreadable")).toBe(false);
      expect(
        yield* commitPrewarmedThreadSnapshot(cache, ENVIRONMENT_ID, detail("missing", 9)),
      ).toBe("populated");
      expect((yield* Ref.get(stored)).get("missing")?.snapshotSequence).toBe(9);
    }),
  );
});

describe("thread activity snapshots", () => {
  const ref = (id: string, status: OrchestrationV2ThreadShell["status"]) => ({
    environmentId: ENVIRONMENT_ID,
    id: ThreadId.make(id),
    source: shell(id, { status }),
  });

  it("reports a thread once when its run finishes, never on the first observation", () => {
    const seeded = seedThreadActivitySnapshot([ref("a", "running"), ref("b", "idle")]);
    const first = advanceThreadActivitySnapshot(seeded, [
      ref("a", "completed"),
      ref("b", "idle"),
      ref("new", "idle"),
    ]);
    expect(first.settled).toEqual([{ environmentId: ENVIRONMENT_ID, threadId: "a" }]);
    expect(advanceThreadActivitySnapshot(first.snapshot, [ref("a", "completed")]).settled).toEqual(
      [],
    );
  });
});

describe("didEnvironmentPrewarmRunsAdvance", () => {
  it("waits for every requested environment that still exists", () => {
    const other = EnvironmentId.make("environment-2");
    const requested = new Map([
      [ENVIRONMENT_ID, null],
      [other, 10],
    ]);
    expect(
      didEnvironmentPrewarmRunsAdvance(
        new Map([
          [ENVIRONMENT_ID, 20],
          [other, 10],
        ]),
        requested,
      ),
    ).toBe(false);
    expect(didEnvironmentPrewarmRunsAdvance(new Map([[ENVIRONMENT_ID, 20]]), requested)).toBe(true);
  });
});

describe("makeEnvironmentThreadPrewarm", () => {
  const makeHarness = Effect.fn("TestThreadPrewarm.makeHarness")(function* (options?: {
    readonly prepared?: Option.Option<PreparedConnection>;
    readonly load?: (threadId: string) => ThreadSnapshotLoadResult;
  }) {
    const { cache, stored } = yield* makeCache({
      shell: Option.some({
        ...v2ShellSnapshot,
        threads: [
          shell("missing", { updatedAt: at("2026-06-04T00:00:00.000Z") }),
          shell("cached", { updatedAt: at("2026-06-03T00:00:00.000Z") }),
          shell("busy", { updatedAt: at("2026-06-06T00:00:00.000Z"), status: "running" }),
        ],
      }),
      threads: [detail("cached", 10)],
    });
    const loaderCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const loader = ThreadSnapshotLoader.of({
      load: (_prepared, threadId) =>
        Ref.update(loaderCalls, (calls) => [...calls, threadId]).pipe(
          Effect.as(
            options?.load?.(threadId) ??
              ({
                _tag: "present",
                snapshot: detail(threadId, 12),
                history: { historyCursor: "cursor-1", hasMoreHistory: true },
              } satisfies ThreadSnapshotLoadResult),
          ),
        ),
    });
    const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
    const prepared = yield* SubscriptionRef.make(options?.prepared ?? Option.some(PREPARED));
    const session = yield* SubscriptionRef.make(Option.none<RpcSession.RpcSession>());
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: supervisorState,
      session,
      prepared,
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
    const requests = yield* Queue.unbounded<ThreadPrewarmTriggerRequest>();
    const statuses = yield* Queue.unbounded<EnvironmentThreadPrewarmStatus>();
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
          changes: Stream.fromQueue(requests),
          fire: (request) => Queue.offer(requests, request).pipe(Effect.asVoid),
        }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(stream, (status) =>
        Queue.offer(status.running ? started : statuses, status),
      ),
    );
    expect(yield* Queue.take(statuses)).toEqual(EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS);

    // Every trigger is debounced before it runs.
    const settle = Effect.yieldNow.pipe(Effect.andThen(TestClock.adjust("3 seconds")));
    return {
      stored,
      loaderCalls,
      statuses,
      started,
      connect: SubscriptionRef.set(supervisorState, CONNECTED_STATE).pipe(Effect.andThen(settle)),
      foreground: Queue.offer(wakeups, "application-active").pipe(Effect.andThen(settle)),
      fire: (request: ThreadPrewarmTriggerRequest) =>
        Queue.offer(requests, request).pipe(Effect.andThen(settle)),
    };
  });

  it.effect("fills only missing idle entries on connect and keeps the bounded cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect;

        expect((yield* Queue.take(harness.started)).running).toBe(true);
        const status = yield* Queue.take(harness.statuses);
        expect(status).toMatchObject({ refreshed: 1, skipped: 1, failed: 0, running: false });
        expect(status.lastRunAt).not.toBeNull();
        expect(yield* Ref.get(harness.loaderCalls)).toEqual(["missing"]);
        const stored = yield* Ref.get(harness.stored);
        expect(stored.get("missing")).toMatchObject({
          snapshotSequence: 12,
          historyCursor: "cursor-1",
          hasMoreHistory: true,
          latestLocalTurnOrdinal: null,
        });
        expect(stored.get("cached")?.snapshotSequence).toBe(10);
        expect(stored.has("busy")).toBe(false);
      }),
    ),
  );

  it.effect("does not cache a fetched projection that is running again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          load: (threadId) => ({
            _tag: "present",
            snapshot: { snapshotSequence: 12, projection: projection(threadId, true) },
          }),
        });
        yield* harness.connect;

        expect(yield* Queue.take(harness.statuses)).toMatchObject({ refreshed: 0, skipped: 2 });
        expect((yield* Ref.get(harness.stored)).has("missing")).toBe(false);
      }),
    ),
  );

  it.effect("cools lifecycle sweeps down but still warms a finished thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect;
        yield* Queue.take(harness.started);
        const first = yield* Queue.take(harness.statuses);

        // A foreground inside the cooldown does nothing at all.
        yield* harness.foreground;
        expect(Option.isNone(yield* Queue.poll(harness.started))).toBe(true);

        yield* harness.fire({
          reason: "thread-settled",
          environmentId: ENVIRONMENT_ID,
          threadId: ThreadId.make("busy"),
        });
        yield* Queue.take(harness.started);
        const targeted = yield* Queue.take(harness.statuses);
        expect(targeted.refreshed).toBe(1);
        // Targeted runs never advance the sweep label.
        expect(targeted.lastRunAt).toBe(first.lastRunAt);
        expect(yield* Ref.get(harness.loaderCalls)).toEqual(["missing", "busy"]);
        expect((yield* Ref.get(harness.stored)).has("busy")).toBe(true);
      }),
    ),
  );

  it.effect("completes a manual request while disconnected without claiming a sync", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ prepared: Option.none() });
        yield* harness.fire({ reason: "manual" });

        const status = yield* Queue.take(harness.statuses);
        expect(status).toMatchObject({ lastRunAt: null, failed: 1, running: false });
        expect(status.lastManualRequestCompletedAt).not.toBeNull();
        expect(Option.isNone(yield* Queue.poll(harness.started))).toBe(true);
        expect(yield* Ref.get(harness.loaderCalls)).toEqual([]);
      }),
    ),
  );
});
