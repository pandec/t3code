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

/**
 * A refresh result also reports which instances actually produced a fresh
 * payload during *this* invocation. Callers cannot infer that from the
 * snapshots alone: those carry previously cached observations too, so a stale
 * neighbour can masquerade as a successful probe.
 *
 * Optional so a newer client keeps working against a server that predates the
 * field: absent means "this server cannot tell us", which callers must treat
 * as inconclusive rather than as an all-probes-failed refresh.
 */
export const ProviderUsageRefreshResult = Schema.Struct({
  snapshots: ProviderInstanceUsageSnapshots,
  refreshedInstanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
});
export type ProviderUsageRefreshResult = typeof ProviderUsageRefreshResult.Type;
