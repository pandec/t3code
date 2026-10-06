/**
 * ProviderInstanceHealth — per-instance provider usage snapshots.
 *
 * Holds the latest opaque usage payload for each provider instance, ordered
 * by server-local observation tokens and owned by one usage source at a time.
 *
 * The state is deliberately in-memory only: usage is a live account
 * condition, and a server restart re-learning it from the next observation
 * is cheaper and safer than persisting a potentially stale snapshot.
 *
 * @module provider/ProviderInstanceHealth
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface ProviderInstanceUsageSnapshot {
  readonly instanceId: ProviderInstanceId;
  readonly payload: unknown;
  /** Unix ms when the payload was observed. */
  readonly observedAt: number;
}

declare const UsageObservationTokenTypeId: unique symbol;

/** Server-local total-order token allocated when a usage observation begins. */
export type UsageObservationToken = number & {
  readonly [UsageObservationTokenTypeId]: typeof UsageObservationTokenTypeId;
};

/**
 * Which class of source owns an instance's usage slot: the provider driver's
 * own account-usage stream, or a configured external usage source. One gateway
 * pool is told from another by the optional source key passed beside it.
 */
export type UsageSourceKind = "driver" | "gateway";

export class ProviderInstanceHealth extends Context.Service<
  ProviderInstanceHealth,
  {
    /** Allocate a total-order token immediately before observing provider usage. */
    readonly beginUsageObservation: () => Effect.Effect<UsageObservationToken>;

    /**
     * Declare which source currently owns an instance's usage slot. Newer
     * declarations win; changing the source (its kind or its key, e.g. another
     * gateway pool; the key defaults to the kind) drops the old one's snapshot.
     */
    readonly setUsageSource: (
      instanceId: ProviderInstanceId,
      sourceKind: UsageSourceKind,
      observationToken: UsageObservationToken,
      sourceKey?: string,
    ) => Effect.Effect<void>;

    /**
     * Store the latest opaque provider usage payload for one instance. Returns
     * whether it was stored: it must come from the active source (kind and key,
     * the key defaulting to the kind) and win the token comparison.
     */
    readonly reportUsageSnapshot: (
      instanceId: ProviderInstanceId,
      payload: unknown,
      /** Unix ms used only for client freshness rendering. */
      observedAt: number,
      observationToken: UsageObservationToken,
      sourceKind: UsageSourceKind,
      sourceKey?: string,
    ) => Effect.Effect<boolean>;

    readonly listUsageSnapshots: () => Effect.Effect<ReadonlyArray<ProviderInstanceUsageSnapshot>>;
  }
>()("t3/provider/ProviderInstanceHealth") {}

export const make = Effect.gen(function* () {
  const nextUsageObservationToken = yield* Ref.make(0);
  const initialUsageObservationToken = 0 as UsageObservationToken;
  // One entry per instance holds both the active source and the whole-payload
  // LWW tombstone. A source transition (kind or key) drops the snapshot but
  // retains its token, so an older observation from a source that later
  // returns cannot replay; reports from any other source are rejected.
  const usageSnapshots = yield* Ref.make<
    ReadonlyMap<
      ProviderInstanceId,
      {
        readonly activeSourceKind: UsageSourceKind;
        readonly activeSourceKey: string;
        readonly sourceObservationToken: UsageObservationToken;
        readonly snapshot: ProviderInstanceUsageSnapshot | undefined;
        readonly snapshotObservationToken: UsageObservationToken;
      }
    >
  >(new Map());

  const beginUsageObservation: ProviderInstanceHealth["Service"]["beginUsageObservation"] = () =>
    Ref.updateAndGet(nextUsageObservationToken, (current) => current + 1).pipe(
      Effect.map((token) => token as UsageObservationToken),
    );

  const setUsageSource: ProviderInstanceHealth["Service"]["setUsageSource"] = Effect.fn(
    "ProviderInstanceHealth.setUsageSource",
  )(function* (instanceId, sourceKind, observationToken, sourceKey: string = sourceKind) {
    yield* Ref.update(usageSnapshots, (snapshots) => {
      const current = snapshots.get(instanceId);
      if (current !== undefined && current.sourceObservationToken >= observationToken) {
        return snapshots;
      }
      const activeSourceKind = current?.activeSourceKind ?? "driver";
      const activeSourceKey = current?.activeSourceKey ?? activeSourceKind;
      return new Map(snapshots).set(instanceId, {
        activeSourceKind: sourceKind,
        activeSourceKey: sourceKey,
        sourceObservationToken: observationToken,
        snapshot:
          activeSourceKind === sourceKind && activeSourceKey === sourceKey
            ? current?.snapshot
            : undefined,
        snapshotObservationToken: current?.snapshotObservationToken ?? initialUsageObservationToken,
      });
    });
  });

  const reportUsageSnapshot: ProviderInstanceHealth["Service"]["reportUsageSnapshot"] = Effect.fn(
    "ProviderInstanceHealth.reportUsageSnapshot",
  )(function* (
    instanceId,
    payload,
    observedAt,
    observationToken,
    sourceKind,
    sourceKey: string = sourceKind,
  ) {
    return yield* Ref.modify(usageSnapshots, (snapshots) => {
      const current = snapshots.get(instanceId);
      const activeSourceKind = current?.activeSourceKind ?? "driver";
      const activeSourceKey = current?.activeSourceKey ?? activeSourceKind;
      const snapshotObservationToken =
        current?.snapshotObservationToken ?? initialUsageObservationToken;
      if (
        activeSourceKind !== sourceKind ||
        activeSourceKey !== sourceKey ||
        snapshotObservationToken >= observationToken
      ) {
        return [false, snapshots] as const;
      }
      return [
        true,
        new Map(snapshots).set(instanceId, {
          activeSourceKind,
          activeSourceKey,
          sourceObservationToken: current?.sourceObservationToken ?? initialUsageObservationToken,
          snapshot: {
            instanceId,
            payload,
            observedAt,
          },
          snapshotObservationToken: observationToken,
        }),
      ] as const;
    });
  });

  const listUsageSnapshots: ProviderInstanceHealth["Service"]["listUsageSnapshots"] = () =>
    Ref.get(usageSnapshots).pipe(
      Effect.map((snapshots) =>
        Array.from(snapshots.values(), ({ snapshot }) => snapshot).filter(
          (snapshot) => snapshot !== undefined,
        ),
      ),
    );

  return {
    beginUsageObservation,
    setUsageSource,
    reportUsageSnapshot,
    listUsageSnapshots,
  } satisfies ProviderInstanceHealth["Service"];
});

export const layer = Layer.effect(ProviderInstanceHealth, make);
