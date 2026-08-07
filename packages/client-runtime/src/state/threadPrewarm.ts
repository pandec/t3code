import {
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadShell,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { threadKey } from "./entities.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import { retainRecentThreadHistory } from "./threadReducer.ts";
import {
  DEFAULT_MESSAGE_OLDER_PAGE_SIZE,
  DEFAULT_MESSAGE_WINDOW_LIMIT,
  DEFAULT_OLDER_TURN_LIMIT,
  ThreadHistoryWindow,
  type ThreadHistoryWindowConfig,
} from "./threadRetention.ts";
import { ThreadSnapshotLoader, type ThreadSnapshotLoadWindow } from "./threadSnapshotHttp.ts";

/**
 * Opportunistic thread-detail prewarming: shortly after an environment
 * connects (and on later app foregrounds), fetch detail snapshots for a few
 * recently active threads and store them in the offline cache. Opening one
 * of those threads then paints instantly from cache and only needs the cheap
 * `afterSequence` socket catch-up instead of blocking on a detail fetch.
 *
 * This is deliberately best-effort: every failure is swallowed after logging,
 * and the regular open-path reconciliation remains the source of truth.
 */

const PREWARM_SETTLE_DELAY = "3 seconds";
const PREWARM_COOLDOWN_MS = 60_000;
const PREWARM_THREAD_LIMIT = 5;
const PREWARM_CONCURRENCY = 2;
const PREWARM_RUN_TIMEOUT_MS = 30_000;

const DEFAULT_PREWARM_HISTORY_WINDOW = {
  messageWindowLimit: DEFAULT_MESSAGE_WINDOW_LIMIT,
  messageOlderPageSize: DEFAULT_MESSAGE_OLDER_PAGE_SIZE,
  initialTurnLimit: null,
  olderTurnLimit: DEFAULT_OLDER_TURN_LIMIT,
  residentMessageCeiling: null,
} satisfies ThreadHistoryWindowConfig;

/**
 * Mirrors the live thread state's capability-gated choice between the current
 * turn page and the legacy message-count window. Web/desktop configure both
 * modes as unbounded, so their prewarm requests remain full-history reads.
 */
function selectPrewarmSnapshotWindow(
  config: { readonly threadSnapshotPagination?: boolean },
  historyWindow: ThreadHistoryWindowConfig,
): ThreadSnapshotLoadWindow | undefined {
  const initialTurnLimit = historyWindow.initialTurnLimit ?? null;
  if (config.threadSnapshotPagination === true && initialTurnLimit !== null) {
    return { turnLimit: initialTurnLimit };
  }
  return historyWindow.messageWindowLimit === null
    ? undefined
    : { messageLimit: historyWindow.messageWindowLimit };
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
  readonly lastRunAt: number | null;
  readonly refreshed: number;
  readonly skipped: number;
  readonly failed: number;
  /** True while a run is in flight; the counts then describe the run before it. */
  readonly running: boolean;
}

export const EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS: EnvironmentThreadPrewarmStatus =
  Object.freeze({
    lastRunAt: null,
    refreshed: 0,
    skipped: 0,
    failed: 0,
    running: false,
  });

function isStreamingSession(thread: Pick<OrchestrationThreadShell, "session">): boolean {
  const status = thread.session?.status;
  return status === "starting" || status === "running";
}

/**
 * On-demand prewarm requests fired from outside the engine: a manual
 * "sync now" action, or a thread whose session just left the streaming
 * states (the earliest legal moment to warm it — streaming snapshots are
 * never persisted). Optional service: without it the engine runs on its
 * lifecycle triggers alone.
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

/**
 * Streaming-state baseline for settle detection, keyed by scoped thread.
 * Mirrors the web turn-completion snapshot pattern: the first observation
 * seeds silently, so initial sync and newly discovered threads never fire.
 */
export type ThreadStreamingSnapshot = ReadonlyMap<string, boolean>;

export interface ThreadStreamingShellRef {
  readonly environmentId: EnvironmentIdType;
  readonly id: ThreadIdType;
  readonly session: OrchestrationThreadShell["session"];
  readonly archivedAt: OrchestrationThreadShell["archivedAt"];
}

export interface SettledThreadRef {
  readonly environmentId: EnvironmentIdType;
  readonly threadId: ThreadIdType;
}

export function seedThreadStreamingSnapshot(
  shells: ReadonlyArray<ThreadStreamingShellRef>,
): ThreadStreamingSnapshot {
  const snapshot = new Map<string, boolean>();
  for (const shell of shells) {
    snapshot.set(
      threadKey({ environmentId: shell.environmentId, threadId: shell.id }),
      isStreamingSession(shell),
    );
  }
  return snapshot;
}

export function advanceThreadStreamingSnapshot(
  previous: ThreadStreamingSnapshot,
  shells: ReadonlyArray<ThreadStreamingShellRef>,
): {
  readonly snapshot: ThreadStreamingSnapshot;
  readonly settled: ReadonlyArray<SettledThreadRef>;
} {
  const snapshot = new Map<string, boolean>();
  const settled: Array<SettledThreadRef> = [];
  for (const shell of shells) {
    const key = threadKey({ environmentId: shell.environmentId, threadId: shell.id });
    const streaming = isStreamingSession(shell);
    snapshot.set(key, streaming);
    if (previous.get(key) === true && !streaming && shell.archivedAt === null) {
      settled.push({ environmentId: shell.environmentId, threadId: shell.id });
    }
  }
  return { snapshot, settled };
}

/**
 * Picks the threads worth warming: recently updated, not archived, and not
 * actively streaming (active threads are server-authoritative and their
 * snapshots are intentionally not persisted; see `shouldPersistThread`).
 */
export function selectPrewarmCandidates(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  limit: number = PREWARM_THREAD_LIMIT,
): ReadonlyArray<OrchestrationThreadShell> {
  return threads
    .filter((thread) => thread.archivedAt === null && !isStreamingSession(thread))
    .sort((left, right) =>
      left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0,
    )
    .slice(0, limit);
}

/**
 * Commits a prewarmed detail snapshot unless the cache already holds the same
 * sequence or a newer one. The stored sequence is re-read immediately before
 * writing so a warm fetch that raced a live thread's own persistence cannot
 * regress the cache or replace equal-sequence message artifacts.
 * Returns whether the snapshot was written.
 */
export const commitPrewarmedThreadSnapshot = Effect.fn("ThreadPrewarm.commit")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentIdType,
  snapshot: OrchestrationThreadDetailSnapshot,
  messageWindowLimit?: number | null,
) {
  const stored = yield* cache
    .loadThread(environmentId, snapshot.thread.id)
    .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadDetailSnapshot>()));
  if (Option.isSome(stored) && stored.value.snapshotSequence >= snapshot.snapshotSequence) {
    return false;
  }
  const retainedSnapshot = {
    ...snapshot,
    thread: retainRecentThreadHistory(
      snapshot.thread,
      // A turn page's opaque cursor describes its message range, so retain its
      // messages verbatim while still applying the shared activity/checkpoint
      // caps. Legacy snapshots carry messageWindow metadata and can safely use
      // the configured message-count retention path.
      snapshot.page === undefined && messageWindowLimit !== undefined ? { messageWindowLimit } : {},
    ),
  };
  yield* cache.saveThread(environmentId, retainedSnapshot);
  return true;
});

const warmEnvironmentOnce = Effect.fn("EnvironmentThreadPrewarm.warmOnce")(function* (input: {
  readonly supervisor: EnvironmentSupervisor["Service"];
  readonly cache: EnvironmentCacheStore["Service"];
  readonly loader: ThreadSnapshotLoader["Service"];
  readonly environmentId: EnvironmentIdType;
  readonly historyWindow: ThreadHistoryWindowConfig;
  /** Restricts a targeted (settle-triggered) run to these threads. */
  readonly only?: ReadonlySet<ThreadIdType>;
}) {
  const prepared = yield* SubscriptionRef.get(input.supervisor.prepared);
  if (Option.isNone(prepared)) {
    return null;
  }
  const session = yield* SubscriptionRef.get(input.supervisor.session);
  const config = yield* Option.match(session, {
    onNone: () => Effect.succeed({}),
    onSome: (value) => value.initialConfig.pipe(Effect.orElseSucceed(() => ({}))),
  });
  const snapshotWindow = selectPrewarmSnapshotWindow(config, input.historyWindow);
  // Candidates come from the cached shell rather than a live shell
  // subscription so prewarming never adds a socket or shell request of its
  // own. The shell state persists each applied snapshot, and the settle delay
  // means the cache is normally current by the time a run starts; a stale
  // shell only costs staler candidate ranking, never cache regressions.
  const shell = yield* input.cache
    .loadShell(input.environmentId)
    .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationShellSnapshot>()));
  if (Option.isNone(shell)) {
    return null;
  }
  const only = input.only;
  const source =
    only === undefined
      ? shell.value.threads
      : shell.value.threads.filter((thread) => only.has(thread.id));
  const candidates = selectPrewarmCandidates(source);
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  yield* Effect.forEach(
    candidates,
    (thread) =>
      Effect.gen(function* () {
        const stored = yield* input.cache
          .loadThread(input.environmentId, thread.id)
          .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadDetailSnapshot>()));
        // The sequence is environment-global, so a cached detail at or past
        // the shell's cursor cannot be behind any change the shell knows
        // about — skip the fetch entirely.
        if (
          Option.isSome(stored) &&
          stored.value.snapshotSequence >= shell.value.snapshotSequence
        ) {
          skipped += 1;
          return;
        }
        const fetched = yield* input.loader.load(prepared.value, thread.id, snapshotWindow);
        if (Option.isNone(fetched)) {
          failed += 1;
          return;
        }
        if (isStreamingSession(fetched.value.thread)) {
          skipped += 1;
          return;
        }
        const committed = yield* commitPrewarmedThreadSnapshot(
          input.cache,
          input.environmentId,
          fetched.value,
          input.historyWindow.messageWindowLimit,
        ).pipe(Effect.orElseSucceed(() => false));
        if (committed) {
          refreshed += 1;
        } else {
          skipped += 1;
        }
      }),
    { concurrency: PREWARM_CONCURRENCY, discard: true },
  );
  const lastRunAt = yield* Clock.currentTimeMillis;
  const status: EnvironmentThreadPrewarmStatus = {
    lastRunAt,
    refreshed,
    skipped,
    failed,
    running: false,
  };
  yield* Effect.logDebug("Prewarmed thread details.").pipe(
    Effect.annotateLogs({
      environmentId: input.environmentId,
      candidates: candidates.length,
      refreshed,
      skipped,
      failed,
    }),
  );
  return status;
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
    const configuredHistoryWindow = yield* Effect.serviceOption(ThreadHistoryWindow);
    const historyWindow = Option.getOrElse(
      configuredHistoryWindow,
      () => DEFAULT_PREWARM_HISTORY_WINDOW,
    );
    const gate = yield* Effect.serviceOption(ThreadPrewarmRunGate);
    const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
    const triggers = yield* Effect.serviceOption(ThreadPrewarmTriggers);
    const environmentId = supervisor.target.environmentId;
    // The cooldown is consumed by full runs only: targeted settle warms and
    // manual syncs never suppress the next lifecycle sweep.
    const lastFullRunAt = yield* Ref.make<number | null>(null);
    const pending = yield* Ref.make(EMPTY_PENDING_TRIGGERS);
    // Carried across runs so the in-flight event can report the previous run's
    // outcome instead of blanking it for the duration of the sync.
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

    const runs = Stream.merge(lifecycleTriggers, requestTriggers).pipe(
      // Accumulate before the debounce so a burst collapses into one run
      // without losing any trigger's intent.
      Stream.mapEffect((trigger) =>
        Ref.update(pending, (current) => accumulateTrigger(current, trigger)),
      ),
      Stream.debounce(PREWARM_SETTLE_DELAY),
      // A run emits a pair: `running: true` the moment the batch commits to
      // doing work, then the settled counts. A batch that decides to do
      // nothing emits neither, so an in-flight indicator never flashes for a
      // no-op sweep.
      Stream.flatMap(() =>
        Stream.unwrap(
          Effect.gen(function* () {
            const batch = yield* Ref.getAndSet(pending, EMPTY_PENDING_TRIGGERS);
            const now = yield* Clock.currentTimeMillis;
            const lastFull = yield* Ref.get(lastFullRunAt);
            const cooldownElapsed = lastFull === null || now - lastFull >= PREWARM_COOLDOWN_MS;
            const consumeCooldown = batch.lifecycle && cooldownElapsed;
            const runFull = batch.manual || consumeCooldown;
            if (!runFull && batch.settled.size === 0) {
              return Stream.empty;
            }
            // Checked before the run is announced, not just inside it: a
            // wakeup that arrives before the environment is connected does no
            // work at all and must not raise an in-flight indicator.
            const prepared = yield* SubscriptionRef.get(supervisor.prepared);
            if (Option.isNone(prepared)) {
              return Stream.empty;
            }
            const previous = yield* Ref.get(lastStatus);
            const run = Effect.gen(function* () {
              const warm = warmEnvironmentOnce({
                supervisor,
                cache,
                loader,
                environmentId,
                historyWindow,
                ...(runFull ? {} : { only: batch.settled }),
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
              let settled: EnvironmentThreadPrewarmStatus;
              if (attempt.kind === "completed" && attempt.status !== null) {
                settled = attempt.status;
                if (consumeCooldown) {
                  yield* Ref.set(lastFullRunAt, settled.lastRunAt);
                }
              } else if (attempt.kind === "timed-out") {
                yield* Effect.logWarning("Thread prewarm run timed out.").pipe(
                  Effect.annotateLogs({ environmentId, timeoutMs: PREWARM_RUN_TIMEOUT_MS }),
                );
                // Suppress an identical lifecycle sweep on an immediate reconnect;
                // a later wakeup retries after the normal cooldown.
                if (consumeCooldown) {
                  const timedOutAt = yield* Clock.currentTimeMillis;
                  yield* Ref.set(lastFullRunAt, timedOutAt);
                }
                settled = {
                  ...EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
                  lastRunAt: previous.lastRunAt,
                  failed: 1,
                };
              } else if (attempt.kind === "failed") {
                settled = {
                  ...EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
                  lastRunAt: previous.lastRunAt,
                  failed: 1,
                };
              } else {
                // A run that found no cached shell still has to close the pair,
                // but it must not claim a run it never completed.
                settled = { ...previous, running: false };
              }
              yield* Ref.set(lastStatus, settled);
              return settled;
            });
            return Stream.make({ ...previous, running: true }).pipe(
              Stream.concat(Stream.fromEffect(run)),
            );
          }),
        ),
      ),
    );
    // `followStreamInEnvironment` may replace this stream's supervisor with
    // `switchMap`. Establish the transient baseline on every execution so an
    // interrupted run cannot leave the retained atom stuck at `running: true`.
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
  /** Latest completed run across environments, or null before the first. */
  readonly lastRunAt: number | null;
  readonly refreshed: number;
  /** True while any environment has a prewarm run in flight. */
  readonly syncing: boolean;
  /** Per-environment completion cursors used to track a manual all-environment run. */
  readonly environmentLastRunAt: ReadonlyMap<EnvironmentIdType, number | null>;
}

const EMPTY_THREAD_PREWARM_SUMMARY: ThreadPrewarmSummary = Object.freeze({
  lastRunAt: null,
  refreshed: 0,
  syncing: false,
  environmentLastRunAt: new Map<EnvironmentIdType, number | null>(),
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
 * requested has completed another run. Removed environments stop blocking;
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
 * Keeps a prewarm stream mounted for every catalog environment and exposes a
 * small aggregate so a single always-mounted subscriber drives all of them
 * (and a "last synced" surface can display it).
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
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const status = Option.getOrElse(
        AsyncResult.value(get(input.statusAtom(environmentId))),
        () => EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
      );
      refreshed += status.refreshed;
      syncing ||= status.running;
      // A stream restart re-emits the empty baseline to clear a stranded
      // `running`, which would otherwise roll this cursor back to null — long
      // enough for "last synced" to read "Not synced yet" and for a pending
      // manual sync to see a false completion. Warmed threads survive the
      // restart, so the cursor does too.
      const environmentLastRun =
        status.lastRunAt ?? previous.environmentLastRunAt.get(environmentId) ?? null;
      environmentLastRunAt.set(environmentId, environmentLastRun);
      if (environmentLastRun !== null && (lastRunAt === null || environmentLastRun > lastRunAt)) {
        lastRunAt = environmentLastRun;
      }
    }
    if (
      previous.lastRunAt === lastRunAt &&
      previous.refreshed === refreshed &&
      previous.syncing === syncing &&
      environmentRunTimesEqual(previous.environmentLastRunAt, environmentLastRunAt)
    ) {
      return previous;
    }
    previous = { lastRunAt, refreshed, syncing, environmentLastRunAt };
    return previous;
  }).pipe(Atom.withLabel("environment-thread-prewarm-summary"));
}
