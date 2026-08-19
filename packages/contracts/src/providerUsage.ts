import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
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

/**
 * Ask which pooled gateway account a thread's live provider session is bound
 * to. The gateway keeps that binding per (session, model), so the caller names
 * the model the thread's session last ran — its persisted model selection, not
 * a merely staged composer choice, which has no binding yet and would make the
 * probe create one. The server supplies the session id from the thread's
 * persisted provider binding.
 */
export const ProviderUsageThreadAccountInput = Schema.Struct({
  threadId: ThreadId,
  model: TrimmedNonEmptyString,
});
export type ProviderUsageThreadAccountInput = typeof ProviderUsageThreadAccountInput.Type;

export const ProviderUsageThreadAccountResult = Schema.Struct({
  /**
   * The gateway `auth_index` of the account serving the thread's session, or
   * null when it cannot be determined (no session yet, a non-gateway thread, a
   * provider without session identity, or a probe failure). Clients join it
   * against the `authIndex` each pooled account row carries in the usage
   * snapshot.
   */
  authIndex: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProviderUsageThreadAccountResult = typeof ProviderUsageThreadAccountResult.Type;

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
