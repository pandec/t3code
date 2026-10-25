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
 * Ask which pooled gateway account a thread's live session is bound to. The gateway binds per
 * (session, model), so pass the thread's persisted model, not a staged composer choice, which has
 * no binding and would make the probe create one. The server supplies the session id.
 */
export const ProviderUsageThreadAccountInput = Schema.Struct({
  threadId: ThreadId,
  model: TrimmedNonEmptyString,
});
export type ProviderUsageThreadAccountInput = typeof ProviderUsageThreadAccountInput.Type;

export const ProviderUsageThreadAccountResult = Schema.Struct({
  /**
   * Gateway `auth_index` of the account serving the thread's session, or null when unknown.
   * Clients join it against each pooled account row's `authIndex` in the usage snapshot.
   */
  authIndex: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProviderUsageThreadAccountResult = typeof ProviderUsageThreadAccountResult.Type;

export const ProviderUsageRefreshResult = Schema.Struct({
  snapshots: ProviderInstanceUsageSnapshots,
  /**
   * Instances that produced a fresh payload during this invocation; snapshots alone can't tell,
   * since they carry cached observations too. Absent means the server predates the field, which
   * callers must treat as inconclusive rather than as all probes failing.
   */
  refreshedInstanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
  /**
   * Optional like `refreshedInstanceIds`, and for the same rolling-compat
   * reason: absent means "this server cannot say why", not "nothing failed".
   */
  failures: Schema.optional(Schema.Array(ProviderUsageRefreshFailure)),
});
export type ProviderUsageRefreshResult = typeof ProviderUsageRefreshResult.Type;
