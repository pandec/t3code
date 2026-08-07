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
import { withEnvironmentCacheMutationLock } from "../platform/environmentCacheMutationLock.ts";
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
 * Opportunistic thread-detail cache population: shortly after an environment
 * connects (and on later app foregrounds), fetch bounded snapshots for a few
 * recently active threads whose detail cache entry is missing. Existing entries
 * are never refreshed because they may contain explicitly loaded scrollback;
 * opening them online uses `afterSequence` to reconcile with the server.
 *
 * This is deliberately best-effort: failures are reported in the run status,
 * and the regular open-path reconciliation remains the source of truth.
 */

const PREWARM_SETTLE_DELAY = "3 seconds";
const PREWARM_COOLDOWN_MS = 60_000;
const PREWARM_THREAD_LIMIT = 5;
const PREWARM_CONCURRENCY = 2;
const PREWARM_RUN_TIMEOUT_MS = 30_000;
const PREWARM_SESSION_WAIT_MS = 2_000;

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
  /** Latest successful cache population; drives the user-facing sync label. */
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
 * Atomically populates a missing cache entry. Prewarm never replaces an
 * existing entry: the client cannot reliably infer whether it contains
 * explicitly loaded scrollback, and the live open path repairs stale entries.
 */
type PrewarmCommitResult = "populated" | "existing" | "failed";

const commitPrewarmedThreadSnapshotResult = Effect.fn("ThreadPrewarm.commitResult")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentIdType,
  snapshot: OrchestrationThreadDetailSnapshot,
  messageWindowLimit?: number | null,
) {
  return yield* withEnvironmentCacheMutationLock(
    cache,
    environmentId,
    cache.loadThread(environmentId, snapshot.thread.id).pipe(
      Effect.matchEffect({
        // A persistence failure leaves cache existence unknown. Fail closed so
        // prewarm can never authorize an overwrite from a failed read.
        onFailure: () => Effect.succeed<PrewarmCommitResult>("failed"),
        onSuccess: (stored) => {
          if (Option.isSome(stored)) {
            return Effect.succeed<PrewarmCommitResult>("existing");
          }
          // Turn pages are already bounded by a coherent server-selected turn range.
          // Retaining any row type independently would create gaps that its opaque
          // cursor cannot recover. Legacy snapshots can safely use client retention
          // because messageWindow is rewritten with the retained message boundary.
          const retainedSnapshot =
            snapshot.page === undefined
              ? {
                  ...snapshot,
                  thread: retainRecentThreadHistory(
                    snapshot.thread,
                    messageWindowLimit === undefined ? {} : { messageWindowLimit },
                  ),
                }
              : snapshot;
          return cache.saveThread(environmentId, retainedSnapshot).pipe(
            Effect.as<PrewarmCommitResult>("populated"),
            Effect.orElseSucceed((): PrewarmCommitResult => "failed"),
          );
        },
      }),
    ),
  );
});

export const commitPrewarmedThreadSnapshot = Effect.fn("ThreadPrewarm.commit")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentIdType,
  snapshot: OrchestrationThreadDetailSnapshot,
  messageWindowLimit?: number | null,
) {
  const result = yield* commitPrewarmedThreadSnapshotResult(
    cache,
    environmentId,
    snapshot,
    messageWindowLimit,
  );
  return result === "populated";
});

const waitForPrewarmSession = (
  supervisor: EnvironmentSupervisor["Service"],
): Effect.Effect<boolean> =>
  SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onSome: () => Effect.succeed(true),
        onNone: () =>
          SubscriptionRef.changes(supervisor.session).pipe(
            Stream.filter(Option.isSome),
            Stream.runHead,
            Effect.as(true),
          ),
      }),
    ),
    Effect.timeoutOption(Duration.millis(PREWARM_SESSION_WAIT_MS)),
    Effect.map(Option.getOrElse(() => false)),
  );

const warmEnvironmentOnce = Effect.fn("EnvironmentThreadPrewarm.warmOnce")(function* (input: {
  readonly supervisor: EnvironmentSupervisor["Service"];
  readonly cache: EnvironmentCacheStore["Service"];
  readonly loader: ThreadSnapshotLoader["Service"];
  readonly environmentId: EnvironmentIdType;
  readonly historyWindow: ThreadHistoryWindowConfig;
  readonly previousLastRunAt: number | null;
  /** Restricts a targeted (settle-triggered) run to these threads. */
  readonly only?: ReadonlySet<ThreadIdType>;
}) {
  const prepared = yield* SubscriptionRef.get(input.supervisor.prepared);
  if (Option.isNone(prepared)) {
    return null;
  }
  const session = yield* SubscriptionRef.get(input.supervisor.session);
  if (Option.isNone(session)) {
    return null;
  }
  const config = yield* session.value.initialConfig.pipe(Effect.orElseSucceed(() => ({})));
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
        const cacheRead = yield* input.cache.loadThread(input.environmentId, thread.id).pipe(
          Effect.match({
            onFailure: () => ({ kind: "failed" as const }),
            onSuccess: (stored) => ({ kind: "loaded" as const, stored }),
          }),
        );
        // A failed read cannot prove the entry is missing. Do not fetch or write:
        // failing closed is the only way to preserve populate-only semantics.
        if (cacheRead.kind === "failed") {
          failed += 1;
          return;
        }
        // Prewarm only fills cold-cache misses. Any existing entry may contain
        // explicitly loaded scrollback that a bounded initial page cannot safely
        // replace, and the live open path will reconcile its freshness.
        if (Option.isSome(cacheRead.stored)) {
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
        const commitResult = yield* commitPrewarmedThreadSnapshotResult(
          input.cache,
          input.environmentId,
          fetched.value,
          input.historyWindow.messageWindowLimit,
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
  const lastRunAt = refreshed > 0 ? yield* Clock.currentTimeMillis : input.previousLastRunAt;
  const status: EnvironmentThreadPrewarmStatus = {
    ...EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
    lastRunAt,
    refreshed,
    skipped,
    failed,
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
      // A runnable batch emits `running: true` followed by settled counts. An
      // unprepared manual/settled request emits only an explicit completion so
      // its caller can stop waiting; a lifecycle no-op emits nothing and never
      // flashes an in-flight indicator.
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
            const previous = yield* Ref.get(lastStatus);
            // Checked before the run is announced, not just inside it: a
            // wakeup that arrives before the environment is connected does no
            // work at all and must not raise an in-flight indicator.
            const prepared = yield* SubscriptionRef.get(supervisor.prepared);
            if (Option.isNone(prepared)) {
              if (!batch.manual && batch.settled.size === 0) {
                return Stream.empty;
              }
              // Complete on-demand requests explicitly without claiming that a
              // sync succeeded. Only manual requests advance the UI completion
              // cursor; settled-only requests still report unavailability.
              const settled = {
                ...EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
                lastRunAt: previous.lastRunAt,
                lastManualRequestCompletedAt: batch.manual
                  ? yield* Clock.currentTimeMillis
                  : previous.lastManualRequestCompletedAt,
                failed: 1,
              };
              yield* Ref.set(lastStatus, settled);
              return Stream.make(settled);
            }
            const run = Effect.gen(function* () {
              // A foreground trigger may land after preparation but before the
              // RPC session is installed. Briefly await it without occupying the
              // mobile-wide run gate; the connected-generation trigger retries
              // later if connection setup takes longer.
              const sessionReady = yield* waitForPrewarmSession(supervisor);
              const warm = warmEnvironmentOnce({
                supervisor,
                cache,
                loader,
                environmentId,
                historyWindow,
                previousLastRunAt: previous.lastRunAt,
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
              const attempt = sessionReady
                ? yield* Option.match(gate, {
                    onNone: () => warm,
                    onSome: (service) => service.run(warm),
                  })
                : { kind: "session-unavailable" as const };
              let settled: EnvironmentThreadPrewarmStatus;
              if (attempt.kind === "completed" && attempt.status !== null) {
                settled = attempt.status;
                if (consumeCooldown) {
                  const completedAt = yield* Clock.currentTimeMillis;
                  yield* Ref.set(lastFullRunAt, completedAt);
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
              } else if (attempt.kind === "session-unavailable") {
                if (batch.manual || batch.settled.size > 0) {
                  // On-demand requests complete explicitly, but an unavailable
                  // session is a failed outcome and must not look like a sync.
                  settled = {
                    ...EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
                    lastRunAt: previous.lastRunAt,
                    failed: 1,
                  };
                } else {
                  // Lifecycle intent is retried by the connected-generation
                  // trigger and must not consume cooldown while sessionless.
                  settled = { ...previous, running: false };
                }
              } else {
                // Preparation/session teardown can race the readiness check, and
                // a cache may have no shell yet. On-demand callers need an
                // explicit unavailable outcome; lifecycle runs remain retryable.
                settled =
                  batch.manual || batch.settled.size > 0
                    ? {
                        ...EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
                        lastRunAt: previous.lastRunAt,
                        failed: 1,
                      }
                    : { ...previous, running: false };
              }
              settled = {
                ...settled,
                lastManualRequestCompletedAt: batch.manual
                  ? yield* Clock.currentTimeMillis
                  : previous.lastManualRequestCompletedAt,
              };
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
  /** Latest successful cache population across environments. */
  readonly lastRunAt: number | null;
  readonly refreshed: number;
  /** True while any environment has a prewarm run in flight. */
  readonly syncing: boolean;
  /** Per-environment successful-population timestamps. */
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
    const environmentLastManualRequestCompletedAt = new Map<EnvironmentIdType, number | null>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const status = Option.getOrElse(
        AsyncResult.value(get(input.statusAtom(environmentId))),
        () => EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
      );
      refreshed += status.refreshed;
      syncing ||= status.running;
      // A stream restart re-emits the empty baseline to clear a stranded
      // `running`. Successful-population and manual-completion cursors must survive
      // that baseline so labels do not roll back and pending requests do not
      // observe a false completion.
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
