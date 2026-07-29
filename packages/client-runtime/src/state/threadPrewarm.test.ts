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
  commitPrewarmedThreadSnapshot,
  makeEnvironmentThreadPrewarm,
  selectPrewarmCandidates,
  ThreadSnapshotLoader,
  type EnvironmentThreadPrewarmStatus,
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
      shell: Option.some(shell),
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
    const statuses = yield* Queue.unbounded<EnvironmentThreadPrewarmStatus>();

    const stream = yield* makeEnvironmentThreadPrewarm().pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      Effect.provideService(ThreadSnapshotLoader, loader),
      Effect.provideService(
        ConnectionWakeups.ConnectionWakeups,
        ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
      ),
    );
    yield* Effect.forkScoped(Stream.runForEach(stream, (status) => Queue.offer(statuses, status)));

    return { supervisorState, prepared, wakeups, statuses, stored, loaderCalls };
  });

  it.effect("warms stale recent threads once the environment connects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
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

  it.effect("does not cool down a no-op foreground attempt before connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ initialPrepared: Option.none() });

        yield* Queue.offer(harness.wakeups, "application-active");
        yield* TestClock.adjust("3 seconds");
        expect(Option.isNone(yield* Queue.poll(harness.statuses))).toBe(true);

        yield* SubscriptionRef.set(harness.prepared, Option.some(PREPARED));
        yield* SubscriptionRef.set(harness.supervisorState, CONNECTED_STATE);
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
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(harness.statuses);

        // A foreground wakeup right after the first run stays within the
        // cooldown and must not trigger another warm pass.
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* TestClock.adjust("3 seconds");
        expect(Option.isNone(yield* Queue.poll(harness.statuses))).toBe(true);

        yield* TestClock.adjust("60 seconds");
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* TestClock.adjust("3 seconds");
        const status = yield* Queue.take(harness.statuses);
        expect(status.skipped).toBe(2);
      }),
    ),
  );
});
