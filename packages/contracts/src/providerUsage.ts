import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Latest opaque subscription-usage payload observed for one provider
 * instance. Providers own the payload shape; clients normalize it and
 * already know each instance's driver from the provider list.
 */
export const ProviderInstanceUsageSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  payload: Schema.Unknown,
  /** Unix milliseconds when the server observed this payload. */
  observedAt: NonNegativeInt,
});
export type ProviderInstanceUsageSnapshot = typeof ProviderInstanceUsageSnapshot.Type;

export const ProviderInstanceUsageSnapshots = Schema.Array(ProviderInstanceUsageSnapshot);
export type ProviderInstanceUsageSnapshots = typeof ProviderInstanceUsageSnapshots.Type;

export const ProviderUsageReadInput = Schema.Struct({});
export type ProviderUsageReadInput = typeof ProviderUsageReadInput.Type;

export const ProviderUsageRefreshInput = Schema.Struct({
  /** Omitted to refresh every enabled, usage-capable provider instance. */
  instanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
});
export type ProviderUsageRefreshInput = typeof ProviderUsageRefreshInput.Type;

export const ProviderUsageSnapshotsResult = Schema.Struct({
  snapshots: ProviderInstanceUsageSnapshots,
});
export type ProviderUsageSnapshotsResult = typeof ProviderUsageSnapshotsResult.Type;

/** Why one instance's probe produced nothing on this refresh. */
export const ProviderUsageRefreshFailure = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Human-readable, already safe to render verbatim in a client warning. */
  reason: Schema.String,
});
export type ProviderUsageRefreshFailure = typeof ProviderUsageRefreshFailure.Type;

export const ProviderUsageRefreshResult = Schema.Struct({
  snapshots: ProviderInstanceUsageSnapshots,
  /**
   * Which instances actually produced a fresh payload during *this*
   * invocation. Callers cannot infer that from the snapshots alone: those
   * carry previously cached observations too, so a stale neighbour can
   * masquerade as a successful probe.
   *
   * Optional so a newer client keeps working against a server that predates
   * the field: absent means "this server cannot tell us", which callers must
   * treat as inconclusive rather than as an all-probes-failed refresh.
   */
  refreshedInstanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
  /**
   * Optional like `refreshedInstanceIds`, and for the same rolling-compat
   * reason: absent means "this server cannot say why", not "nothing failed".
   */
  failures: Schema.optional(Schema.Array(ProviderUsageRefreshFailure)),
});
export type ProviderUsageRefreshResult = typeof ProviderUsageRefreshResult.Type;
