import type {
  EnvironmentId as EnvironmentIdType,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellThreadStatus,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { withEnvironmentCacheMutationLock } from "../platform/environmentCacheMutationLock.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { threadKey } from "./entities.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import { ThreadSnapshotLoader, type ThreadSnapshotLoadResult } from "./threadSnapshotHttp.ts";

/**
 * Opportunistic thread-detail cache population (fork): shortly after an
 * environment connects (and on later app foregrounds), fetch bounded v2
 * snapshots for a few recently active idle threads whose cache entry is
 * missing, so they can be read offline. Existing entries are never refreshed;
 * opening them online resumes with `afterSequence`.
 *
 * Best-effort: failures are reported in the run status, and the regular
 * open-path reconciliation remains the source of truth.
 */

const PREWARM_SETTLE_DELAY = "3 seconds";
const PREWARM_COOLDOWN_MS = 60_000;
const PREWARM_THREAD_LIMIT = 5;
const PREWARM_CONCURRENCY = 2;
const PREWARM_RUN_TIMEOUT_MS = 30_000;

// Mirrors the thread state's persistence rule: active runs are
// server-authoritative and their projections are never cached.
const ACTIVE_STATUSES: ReadonlySet<OrchestrationV2ShellThreadStatus> = new Set([
  "preparing",
  "starting",
  "running",
]);

function isPrewarmActiveStatus(status: OrchestrationV2ShellThreadStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

function isCacheableProjection(projection: OrchestrationV2ThreadProjection): boolean {
  return (
    projection.thread.archivedAt === null &&
    projection.thread.deletedAt === null &&
    !projection.runs.some((run) => ACTIVE_STATUSES.has(run.status))
  );
}

export class ThreadPrewarmRunGate extends Context.Service<
  ThreadPrewarmRunGate,
  {
    readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@t3tools/client-runtime/state/threadPrewarm/ThreadPrewarmRunGate") {}

/** Mobile provides one shared instance so environment batches cannot overlap. */
export const threadPrewarmRunGateLayer: Layer.Layer<ThreadPrewarmRunGate> = Layer.effect(
  ThreadPrewarmRunGate,
  Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    return ThreadPrewarmRunGate.of({
      run: (effect) => semaphore.withPermits(1)(effect),
    });
  }),
);

export interface EnvironmentThreadPrewarmStatus {
  /**
   * Completion time of the latest full sweep that was not a total failure: one
   * that populated an entry, confirmed an entry already cached, or found
   * nothing to warm. Drives the user-facing sync label; targeted runs for
   * just-finished threads never advance it.
   */
  readonly lastRunAt: number | null;
  /** Completion cursor for manual requests, including unavailable outcomes. */
  readonly lastManualRequestCompletedAt: number | null;
  readonly refreshed: number;
  readonly skipped: number;
  readonly failed: number;
  /** True while a run is in flight; the counts then describe the run before it. */
  readonly running: boolean;
}

export const EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS: EnvironmentThreadPrewarmStatus =
  Object.freeze({
    lastRunAt: null,
    lastManualRequestCompletedAt: null,
    refreshed: 0,
    skipped: 0,
    failed: 0,
    running: false,
  });

/**
 * On-demand prewarm requests fired from outside the engine: the manual
 * Sync Threads action, or a thread whose run just finished (the earliest
 * moment its projection may be cached). Optional service: without it the
 * engine runs on its lifecycle triggers alone.
 */
export interface ThreadPrewarmTriggerRequest {
  readonly reason: "manual" | "thread-settled";
  /** Absent on manual requests: they target every environment. */
  readonly environmentId?: EnvironmentIdType;
  readonly threadId?: ThreadIdType;
}

export class ThreadPrewarmTriggers extends Context.Service<
  ThreadPrewarmTriggers,
  {
    readonly changes: Stream.Stream<ThreadPrewarmTriggerRequest>;
    readonly fire: (request: ThreadPrewarmTriggerRequest) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/state/threadPrewarm/ThreadPrewarmTriggers") {}

export const threadPrewarmTriggersLayer: Layer.Layer<ThreadPrewarmTriggers> = Layer.effect(
  ThreadPrewarmTriggers,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<ThreadPrewarmTriggerRequest>();
    return ThreadPrewarmTriggers.of({
      changes: Stream.fromPubSub(pubsub),
      fire: (request) => PubSub.publish(pubsub, request).pipe(Effect.asVoid),
    });
  }),
);

function isPrewarmableShell(
  thread: Pick<OrchestrationV2ThreadShell, "archivedAt" | "deletedAt" | "lineage">,
): boolean {
  // Subagent threads are not navigable from the thread list.
  return (
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.lineage.relationshipToParent !== "subagent"
  );
}

/**
 * Activity baseline for completion detection, keyed by scoped thread. The
 * first observation seeds silently, so initial sync and newly discovered
 * threads never fire.
 */
export type ThreadActivitySnapshot = ReadonlyMap<string, boolean>;

export interface ThreadActivityShellRef {
  readonly environmentId: EnvironmentIdType;
  readonly id: ThreadIdType;
  readonly source: Pick<
    OrchestrationV2ThreadShell,
    "status" | "archivedAt" | "deletedAt" | "lineage"
  >;
}

export interface SettledThreadRef {
  readonly environmentId: EnvironmentIdType;
  readonly threadId: ThreadIdType;
}

export function seedThreadActivitySnapshot(
  shells: ReadonlyArray<ThreadActivityShellRef>,
): ThreadActivitySnapshot {
  const snapshot = new Map<string, boolean>();
  for (const shell of shells) {
    snapshot.set(
      threadKey({ environmentId: shell.environmentId, threadId: shell.id }),
      isPrewarmActiveStatus(shell.source.status),
    );
  }
  return snapshot;
}

export function advanceThreadActivitySnapshot(
  previous: ThreadActivitySnapshot,
  shells: ReadonlyArray<ThreadActivityShellRef>,
): {
  readonly snapshot: ThreadActivitySnapshot;
  readonly settled: ReadonlyArray<SettledThreadRef>;
} {
  const snapshot = new Map<string, boolean>();
  const settled: Array<SettledThreadRef> = [];
  for (const shell of shells) {
    const key = threadKey({ environmentId: shell.environmentId, threadId: shell.id });
    const active = isPrewarmActiveStatus(shell.source.status);
    snapshot.set(key, active);
    if (previous.get(key) === true && !active && isPrewarmableShell(shell.source)) {
      settled.push({ environmentId: shell.environmentId, threadId: shell.id });
    }
  }
  return { snapshot, settled };
}

/**
 * Picks the threads worth warming: recently updated, navigable, and not
 * actively running.
 */
export function selectPrewarmCandidates(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  limit: number = PREWARM_THREAD_LIMIT,
): ReadonlyArray<ThreadIdType> {
  return threads
    .filter((thread) => isPrewarmableShell(thread) && !isPrewarmActiveStatus(thread.status))
    .map((thread) => ({ id: thread.id, updatedAt: DateTime.toEpochMillis(thread.updatedAt) }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)
    .map((thread) => thread.id);
}

/** Cache entry for a fetched snapshot; bounded windows keep their history cursor. */
function prewarmedCacheEntry(
  result: Extract<ThreadSnapshotLoadResult, { readonly _tag: "present" }>,
): OrchestrationV2ThreadDetailSnapshot {
  if (result.history === undefined) return result.snapshot;
  return {
    snapshotSequence: result.snapshot.snapshotSequence,
    projection: result.snapshot.projection,
    historyCursor: result.history.historyCursor,
    hasMoreHistory: result.history.hasMoreHistory,
    latestLocalTurnOrdinal: result.history.latestLocalTurnOrdinal ?? null,
  };
}

type PrewarmCommitResult = "populated" | "existing" | "failed";

/**
 * Atomically populates a missing cache entry. Prewarm never replaces an
 * existing entry: the live open path owns its freshness.
 */
export const commitPrewarmedThreadSnapshot = Effect.fn("ThreadPrewarm.commit")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentIdType,
  snapshot: OrchestrationV2ThreadDetailSnapshot,
) {
  return yield* withEnvironmentCacheMutationLock(
    cache,
    environmentId,
    cache.loadThread(environmentId, snapshot.projection.thread.id).pipe(
      Effect.matchEffect({
        // A failed read leaves existence unknown. Fail closed so prewarm can
        // never overwrite an entry it could not see.
        onFailure: () => Effect.succeed<PrewarmCommitResult>("failed"),
        onSuccess: (stored) =>
          Option.isSome(stored)
            ? Effect.succeed<PrewarmCommitResult>("existing")
            : cache.saveThread(environmentId, snapshot).pipe(
                Effect.as<PrewarmCommitResult>("populated"),
                Effect.orElseSucceed((): PrewarmCommitResult => "failed"),
              ),
      }),
    ),
  );
});

const warmEnvironmentOnce = Effect.fn("EnvironmentThreadPrewarm.warmOnce")(function* (input: {
  readonly supervisor: EnvironmentSupervisor["Service"];
  readonly cache: EnvironmentCacheStore["Service"];
  readonly loader: ThreadSnapshotLoader["Service"];
  readonly environmentId: EnvironmentIdType;
  readonly previousLastRunAt: number | null;
  /** Sweeps the cached shell's candidates in addition to `settled`. */
  readonly full: boolean;
  /** Threads whose run just finished; warmed first, even in a full sweep. */
  readonly settled: ReadonlySet<ThreadIdType>;
}) {
  const prepared = yield* SubscriptionRef.get(input.supervisor.prepared);
  if (Option.isNone(prepared)) {
    return null;
  }
  // The live shell already saw settled threads finish; the cached shell can
  // lag behind it, so they are taken as given and ranked first.
  let swept: ReadonlyArray<ThreadIdType> = [];
  if (input.full) {
    // Candidates come from the cached shell so prewarming never adds a socket
    // or shell request of its own. A slightly stale shell only costs ranking;
    // fetched projections are re-checked before anything is cached.
    const shell = yield* input.cache
      .loadShell(input.environmentId)
      .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationV2ShellSnapshot>()));
    if (Option.isNone(shell) && input.settled.size === 0) {
      return null;
    }
    if (Option.isSome(shell)) {
      swept = selectPrewarmCandidates(shell.value.threads);
    }
  }
  const candidates = [...new Set([...input.settled, ...swept])].slice(0, PREWARM_THREAD_LIMIT);
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  yield* Effect.forEach(
    candidates,
    (threadId) =>
      Effect.gen(function* () {
        const cacheRead = yield* input.cache.loadThread(input.environmentId, threadId).pipe(
          Effect.match({
            onFailure: () => ({ kind: "failed" as const }),
            onSuccess: (stored) => ({ kind: "loaded" as const, stored }),
          }),
        );
        // A failed read cannot prove the entry is missing: fail closed.
        if (cacheRead.kind === "failed") {
          failed += 1;
          return;
        }
        if (Option.isSome(cacheRead.stored)) {
          skipped += 1;
          return;
        }
        const fetched = yield* input.loader.load(prepared.value, threadId);
        if (fetched._tag === "unavailable") {
          failed += 1;
          return;
        }
        // A deleted, archived or (again) running thread has nothing to warm.
        if (fetched._tag === "missing" || !isCacheableProjection(fetched.snapshot.projection)) {
          skipped += 1;
          return;
        }
        const commitResult = yield* commitPrewarmedThreadSnapshot(
          input.cache,
          input.environmentId,
          prewarmedCacheEntry(fetched),
        );
        if (commitResult === "populated") {
          refreshed += 1;
        } else if (commitResult === "existing") {
          skipped += 1;
        } else {
          failed += 1;
        }
      }),
    { concurrency: PREWARM_CONCURRENCY, discard: true },
  );
  // A full run that only skipped already-cached threads still swept them, so
  // it counts as a sync; so does one that found nothing to warm. A run where
  // every candidate failed confirmed nothing, and a targeted run says nothing
  // about the sweep the label reports; both keep the previous timestamp.
  const lastRunAt =
    !input.full || (failed > 0 && refreshed === 0 && skipped === 0)
      ? input.previousLastRunAt
      : yield* Clock.currentTimeMillis;
  yield* Effect.logDebug("Prewarmed thread details.").pipe(
    Effect.annotateLogs({
      environmentId: input.environmentId,
      candidates: candidates.length,
      refreshed,
      skipped,
      failed,
    }),
  );
  return {
    ...EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
    lastRunAt,
    refreshed,
    skipped,
    failed,
  } satisfies EnvironmentThreadPrewarmStatus;
});

interface PendingPrewarmTriggers {
  readonly lifecycle: boolean;
  readonly manual: boolean;
  readonly settled: ReadonlySet<ThreadIdType>;
}

const EMPTY_PENDING_TRIGGERS: PendingPrewarmTriggers = {
  lifecycle: false,
  manual: false,
  settled: new Set<ThreadIdType>(),
};

type PrewarmTrigger =
  | { readonly kind: "lifecycle" }
  | { readonly kind: "manual" }
  | { readonly kind: "settled"; readonly threadId: ThreadIdType };

function accumulateTrigger(
  pending: PendingPrewarmTriggers,
  trigger: PrewarmTrigger,
): PendingPrewarmTriggers {
  switch (trigger.kind) {
    case "lifecycle":
      return { ...pending, lifecycle: true };
    case "manual":
      return { ...pending, manual: true };
    case "settled":
      return { ...pending, settled: new Set(pending.settled).add(trigger.threadId) };
  }
}

export const makeEnvironmentThreadPrewarm = Effect.fn("EnvironmentThreadPrewarm.make")(
  function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const cache = yield* EnvironmentCacheStore;
    const loader = yield* ThreadSnapshotLoader;
    const gate = yield* Effect.serviceOption(ThreadPrewarmRunGate);
    const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
    const triggers = yield* Effect.serviceOption(ThreadPrewarmTriggers);
    const environmentId = supervisor.target.environmentId;
    // Only lifecycle sweeps consume the cooldown: targeted and manual runs
    // never suppress the next lifecycle sweep.
    const lastFullRunAt = yield* Ref.make<number | null>(null);
    const pending = yield* Ref.make(EMPTY_PENDING_TRIGGERS);
    // Carried across runs so the in-flight event reports the previous outcome.
    const lastStatus = yield* Ref.make(EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS);

    const connectedGenerations = SubscriptionRef.changes(supervisor.state).pipe(
      Stream.filterMap((state) =>
        state.phase === "connected" ? Result.succeed(state.generation) : Result.failVoid,
      ),
      Stream.changes,
    );
    const foregroundWakeups = Option.match(wakeups, {
      onNone: () => Stream.never,
      onSome: (service) =>
        service.changes.pipe(Stream.filter((reason) => reason === "application-active")),
    });
    const lifecycleTriggers = Stream.merge(connectedGenerations, foregroundWakeups).pipe(
      Stream.map((): PrewarmTrigger => ({ kind: "lifecycle" })),
    );
    const requestTriggers = Option.match(triggers, {
      onNone: () => Stream.never as Stream.Stream<PrewarmTrigger>,
      onSome: (service) =>
        service.changes.pipe(
          Stream.filterMap((request): Result.Result<PrewarmTrigger, void> => {
            if (request.reason === "manual") {
              return request.environmentId === undefined || request.environmentId === environmentId
                ? Result.succeed({ kind: "manual" })
                : Result.failVoid;
            }
            return request.environmentId === environmentId && request.threadId !== undefined
              ? Result.succeed({ kind: "settled", threadId: request.threadId })
              : Result.failVoid;
          }),
        ),
    });

    const unavailableStatus = (previous: EnvironmentThreadPrewarmStatus) => ({
      ...EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
      lastRunAt: previous.lastRunAt,
      failed: 1,
    });

    const runs = Stream.merge(lifecycleTriggers, requestTriggers).pipe(
      // Accumulate before the debounce so a burst collapses into one run
      // without losing any trigger's intent.
      Stream.mapEffect((trigger) =>
        Ref.update(pending, (current) => accumulateTrigger(current, trigger)),
      ),
      Stream.debounce(PREWARM_SETTLE_DELAY),
      // A runnable batch emits `running: true` followed by its outcome. An
      // unprepared on-demand request emits only an explicit completion so its
      // caller can stop waiting; a lifecycle no-op emits nothing.
      Stream.flatMap(() =>
        Stream.unwrap(
          Effect.gen(function* () {
            const batch = yield* Ref.getAndSet(pending, EMPTY_PENDING_TRIGGERS);
            const now = yield* Clock.currentTimeMillis;
            const lastFull = yield* Ref.get(lastFullRunAt);
            const cooldownElapsed = lastFull === null || now - lastFull >= PREWARM_COOLDOWN_MS;
            const consumeCooldown = batch.lifecycle && cooldownElapsed;
            const runFull = batch.manual || consumeCooldown;
            const onDemand = batch.manual || batch.settled.size > 0;
            if (!runFull && batch.settled.size === 0) {
              return Stream.empty;
            }
            const previous = yield* Ref.get(lastStatus);
            const completeWith = Effect.fn("EnvironmentThreadPrewarm.complete")(function* (
              status: EnvironmentThreadPrewarmStatus,
            ) {
              const settled = {
                ...status,
                running: false,
                // Only manual requests advance the UI completion cursor.
                lastManualRequestCompletedAt: batch.manual
                  ? yield* Clock.currentTimeMillis
                  : previous.lastManualRequestCompletedAt,
              };
              yield* Ref.set(lastStatus, settled);
              return settled;
            });
            // Checked before announcing the run: a wakeup that lands before the
            // environment is connected must not raise an in-flight indicator.
            if (Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))) {
              return onDemand
                ? Stream.fromEffect(completeWith(unavailableStatus(previous)))
                : Stream.empty;
            }
            const run = Effect.gen(function* () {
              const warm = warmEnvironmentOnce({
                supervisor,
                cache,
                loader,
                environmentId,
                previousLastRunAt: previous.lastRunAt,
                full: runFull,
                settled: batch.settled,
              }).pipe(
                Effect.timeoutOption(Duration.millis(PREWARM_RUN_TIMEOUT_MS)),
                Effect.map(
                  Option.match({
                    onNone: () => ({ kind: "timed-out" as const }),
                    onSome: (status) => ({ kind: "completed" as const, status }),
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Thread prewarm run failed.").pipe(
                    Effect.annotateLogs({ environmentId, cause: String(cause) }),
                    Effect.as({ kind: "failed" as const }),
                  ),
                ),
              );
              const attempt = yield* Option.match(gate, {
                onNone: () => warm,
                onSome: (service) => service.run(warm),
              });
              if (attempt.kind === "completed" && attempt.status !== null) {
                if (consumeCooldown) {
                  yield* Ref.set(lastFullRunAt, yield* Clock.currentTimeMillis);
                }
                return yield* completeWith(attempt.status);
              }
              if (attempt.kind === "timed-out") {
                yield* Effect.logWarning("Thread prewarm run timed out.").pipe(
                  Effect.annotateLogs({ environmentId, timeoutMs: PREWARM_RUN_TIMEOUT_MS }),
                );
                // Suppress an identical lifecycle sweep on an immediate reconnect.
                if (consumeCooldown) {
                  yield* Ref.set(lastFullRunAt, yield* Clock.currentTimeMillis);
                }
                return yield* completeWith(unavailableStatus(previous));
              }
              if (attempt.kind === "failed" || onDemand) {
                return yield* completeWith(unavailableStatus(previous));
              }
              // Preparation teardown raced the readiness check, or no shell is
              // cached yet. Lifecycle runs stay retryable and keep their counts.
              return yield* completeWith(previous);
            });
            return Stream.make({ ...previous, running: true }).pipe(
              Stream.concat(Stream.fromEffect(run)),
            );
          }),
        ),
      ),
    );
    // `followStreamInEnvironment` may replace this stream's supervisor. Emit
    // the baseline on every execution so an interrupted run cannot leave the
    // retained atom stuck at `running: true`.
    return Stream.make(EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS).pipe(Stream.concat(runs));
  },
);

export function threadPrewarmChanges(environmentId: EnvironmentIdType) {
  return followStreamInEnvironment(environmentId, Stream.unwrap(makeEnvironmentThreadPrewarm()));
}

export function createEnvironmentThreadPrewarmAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
) {
  const family = Atom.family((environmentId: EnvironmentIdType) =>
    runtime
      .atom(threadPrewarmChanges(environmentId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
      })
      .pipe(Atom.withLabel(`environment-thread-prewarm:${environmentId}`)),
  );
  return {
    statusAtom: (environmentId: EnvironmentIdType) => family(environmentId),
  };
}

export interface ThreadPrewarmSummary {
  /** Latest sweep across environments; targeted runs and total failures do not advance it. */
  readonly lastRunAt: number | null;
  readonly refreshed: number;
  /** True while any environment has a prewarm run in flight. */
  readonly syncing: boolean;
  /**
   * Per-environment sweep timestamps. Not a completion signal: a request whose
   * candidates all failed never advances this; use the manual cursor instead.
   */
  readonly environmentLastRunAt: ReadonlyMap<EnvironmentIdType, number | null>;
  /** Per-environment cursors used to track manual request completion. */
  readonly environmentLastManualRequestCompletedAt: ReadonlyMap<EnvironmentIdType, number | null>;
}

const EMPTY_THREAD_PREWARM_SUMMARY: ThreadPrewarmSummary = Object.freeze({
  lastRunAt: null,
  refreshed: 0,
  syncing: false,
  environmentLastRunAt: new Map<EnvironmentIdType, number | null>(),
  environmentLastManualRequestCompletedAt: new Map<EnvironmentIdType, number | null>(),
});

function environmentRunTimesEqual(
  left: ReadonlyMap<EnvironmentIdType, number | null>,
  right: ReadonlyMap<EnvironmentIdType, number | null>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [environmentId, lastRunAt] of left) {
    if (!right.has(environmentId) || right.get(environmentId) !== lastRunAt) return false;
  }
  return true;
}

/**
 * Returns true after every environment present when a manual sync was
 * requested has reached a terminal outcome. Removed environments stop blocking;
 * environments added after the request join the next manual sync instead.
 */
export function didEnvironmentPrewarmRunsAdvance(
  current: ReadonlyMap<EnvironmentIdType, number | null>,
  requestedFrom: ReadonlyMap<EnvironmentIdType, number | null>,
): boolean {
  for (const [environmentId, lastRunAt] of requestedFrom) {
    if (current.has(environmentId) && current.get(environmentId) === lastRunAt) return false;
  }
  return true;
}

/**
 * Keeps a prewarm stream mounted for every enabled environment and exposes a
 * small aggregate, so a single always-mounted subscriber drives all of them.
 */
export function createThreadPrewarmSummaryAtom<E>(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly statusAtom: (
    environmentId: EnvironmentIdType,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadPrewarmStatus, E>>;
}) {
  let previous = EMPTY_THREAD_PREWARM_SUMMARY;
  return Atom.make((get) => {
    let lastRunAt: number | null = null;
    let refreshed = 0;
    let syncing = false;
    const environmentLastRunAt = new Map<EnvironmentIdType, number | null>();
    const environmentLastManualRequestCompletedAt = new Map<EnvironmentIdType, number | null>();
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const status = Option.getOrElse(
        AsyncResult.value(get(input.statusAtom(environmentId))),
        () => EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
      );
      refreshed += status.refreshed;
      syncing ||= status.running;
      // A stream restart re-emits the empty baseline. Completed-run and
      // manual-completion cursors survive it so labels do not roll back and
      // pending requests do not observe a false completion.
      const environmentLastRun =
        status.lastRunAt ?? previous.environmentLastRunAt.get(environmentId) ?? null;
      const environmentLastManualCompletion =
        status.lastManualRequestCompletedAt ??
        previous.environmentLastManualRequestCompletedAt.get(environmentId) ??
        null;
      environmentLastRunAt.set(environmentId, environmentLastRun);
      environmentLastManualRequestCompletedAt.set(environmentId, environmentLastManualCompletion);
      if (environmentLastRun !== null && (lastRunAt === null || environmentLastRun > lastRunAt)) {
        lastRunAt = environmentLastRun;
      }
    }
    if (
      previous.lastRunAt === lastRunAt &&
      previous.refreshed === refreshed &&
      previous.syncing === syncing &&
      environmentRunTimesEqual(previous.environmentLastRunAt, environmentLastRunAt) &&
      environmentRunTimesEqual(
        previous.environmentLastManualRequestCompletedAt,
        environmentLastManualRequestCompletedAt,
      )
    ) {
      return previous;
    }
    previous = {
      lastRunAt,
      refreshed,
      syncing,
      environmentLastRunAt,
      environmentLastManualRequestCompletedAt,
    };
    return previous;
  }).pipe(Atom.withLabel("environment-thread-prewarm-summary"));
}
