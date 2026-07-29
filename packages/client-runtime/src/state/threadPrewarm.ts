import {
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";

/**
 * Opportunistic thread-detail prewarming: shortly after an environment
 * connects (and on later app foregrounds), fetch full detail snapshots for a
 * few recently active threads and store them in the offline cache. Opening one
 * of those threads then paints instantly from cache and only needs the cheap
 * `afterSequence` socket catch-up instead of blocking on a full detail fetch.
 *
 * This is deliberately best-effort: every failure is swallowed after logging,
 * and the regular open-path reconciliation remains the source of truth.
 */

const PREWARM_SETTLE_DELAY = "3 seconds";
const PREWARM_COOLDOWN_MS = 60_000;
const PREWARM_THREAD_LIMIT = 5;
const PREWARM_CONCURRENCY = 2;
const PREWARM_RUN_TIMEOUT_MS = 30_000;

export interface EnvironmentThreadPrewarmStatus {
  readonly lastRunAt: number | null;
  readonly refreshed: number;
  readonly skipped: number;
  readonly failed: number;
}

export const EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS: EnvironmentThreadPrewarmStatus =
  Object.freeze({
    lastRunAt: null,
    refreshed: 0,
    skipped: 0,
    failed: 0,
  });

function isStreamingSession(thread: OrchestrationThreadShell): boolean {
  const status = thread.session?.status;
  return status === "starting" || status === "running";
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
 * Commits a prewarmed detail snapshot unless the cache already holds a newer
 * one. The stored sequence is re-read immediately before writing so a warm
 * fetch that raced a live thread's own persistence cannot regress the cache.
 * Returns whether the snapshot was written.
 */
export const commitPrewarmedThreadSnapshot = Effect.fn("ThreadPrewarm.commit")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentIdType,
  snapshot: OrchestrationThreadDetailSnapshot,
) {
  const stored = yield* cache
    .loadThread(environmentId, snapshot.thread.id)
    .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadDetailSnapshot>()));
  if (Option.isSome(stored) && stored.value.snapshotSequence > snapshot.snapshotSequence) {
    return false;
  }
  yield* cache.saveThread(environmentId, snapshot);
  return true;
});

const warmEnvironmentOnce = Effect.fn("EnvironmentThreadPrewarm.warmOnce")(function* (input: {
  readonly supervisor: EnvironmentSupervisor["Service"];
  readonly cache: EnvironmentCacheStore["Service"];
  readonly loader: ThreadSnapshotLoader["Service"];
  readonly environmentId: EnvironmentIdType;
}) {
  const prepared = yield* SubscriptionRef.get(input.supervisor.prepared);
  if (Option.isNone(prepared)) {
    return null;
  }
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
  const candidates = selectPrewarmCandidates(shell.value.threads);
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
        const fetched = yield* input.loader.load(prepared.value, thread.id);
        if (Option.isNone(fetched)) {
          failed += 1;
          return;
        }
        const committed = yield* commitPrewarmedThreadSnapshot(
          input.cache,
          input.environmentId,
          fetched.value,
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
  const status: EnvironmentThreadPrewarmStatus = { lastRunAt, refreshed, skipped, failed };
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

export const makeEnvironmentThreadPrewarm = Effect.fn("EnvironmentThreadPrewarm.make")(
  function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const cache = yield* EnvironmentCacheStore;
    const loader = yield* ThreadSnapshotLoader;
    const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
    const environmentId = supervisor.target.environmentId;
    const lastTriggeredAt = yield* Ref.make<number | null>(null);

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

    return Stream.merge(connectedGenerations, foregroundWakeups).pipe(
      Stream.debounce(PREWARM_SETTLE_DELAY),
      Stream.mapEffect(() =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const last = yield* Ref.get(lastTriggeredAt);
          if (last !== null && now - last < PREWARM_COOLDOWN_MS) {
            return Option.none<EnvironmentThreadPrewarmStatus>();
          }
          yield* Ref.set(lastTriggeredAt, now);
          return yield* warmEnvironmentOnce({ supervisor, cache, loader, environmentId }).pipe(
            Effect.timeoutOption(Duration.millis(PREWARM_RUN_TIMEOUT_MS)),
            Effect.map((result) =>
              Option.flatMap(result, (status) => Option.fromNullishOr(status)),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Thread prewarm run failed.").pipe(
                Effect.annotateLogs({ environmentId, cause: String(cause) }),
                Effect.as(Option.none<EnvironmentThreadPrewarmStatus>()),
              ),
            ),
          );
        }),
      ),
      Stream.filterMap((status) =>
        Option.isSome(status) ? Result.succeed(status.value) : Result.failVoid,
      ),
    );
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

/**
 * Keeps a prewarm stream mounted for every catalog environment and exposes a
 * small aggregate so a single always-mounted subscriber drives all of them.
 */
export function createThreadPrewarmSummaryAtom<E>(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly statusAtom: (
    environmentId: EnvironmentIdType,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadPrewarmStatus, E>>;
}) {
  return Atom.make((get) => {
    let refreshed = 0;
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const status = Option.getOrElse(
        AsyncResult.value(get(input.statusAtom(environmentId))),
        () => EMPTY_ENVIRONMENT_THREAD_PREWARM_STATUS,
      );
      refreshed += status.refreshed;
    }
    return refreshed;
  }).pipe(Atom.withLabel("environment-thread-prewarm-summary"));
}
