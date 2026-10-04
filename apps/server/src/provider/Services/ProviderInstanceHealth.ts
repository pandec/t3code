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
 * @module provider/Services/ProviderInstanceHealth
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

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

export interface ProviderInstanceHealthShape {
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

export class ProviderInstanceHealth extends Context.Service<
  ProviderInstanceHealth,
  ProviderInstanceHealthShape
>()("t3/provider/Services/ProviderInstanceHealth") {}
