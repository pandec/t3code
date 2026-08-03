import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderUsageRefreshOutcome {
  /**
   * The instances that yielded a fresh payload on this call, so callers can
   * tell an all-probes-failed refresh from a successful one without
   * second-guessing snapshot timestamps.
   */
  readonly refreshedInstanceIds: ReadonlyArray<ProviderInstanceId>;
  /**
   * Why instances that produced nothing failed, where a probe error carried a
   * message. An instance can be absent from both lists: "no usage available"
   * is not a failure.
   */
  readonly failures: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly reason: string;
  }>;
}

export interface ProviderUsageRefreshShape {
  /**
   * Refresh enabled, usage-capable provider instances. Concurrent callers join
   * the same per-instance probe; provider failures are isolated and logged.
   */
  readonly refresh: (
    instanceIds?: ReadonlyArray<ProviderInstanceId>,
  ) => Effect.Effect<ProviderUsageRefreshOutcome>;
}

export class ProviderUsageRefresh extends Context.Service<
  ProviderUsageRefresh,
  ProviderUsageRefreshShape
>()("t3/provider/Services/ProviderUsageRefresh") {}
