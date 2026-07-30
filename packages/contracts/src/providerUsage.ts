import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Latest opaque subscription-usage payload observed for one provider
 * instance. Providers own the payload shape; clients normalize it.
 */
export const ProviderInstanceUsageSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
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
