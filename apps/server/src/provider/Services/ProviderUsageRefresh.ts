import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderUsageRefreshShape {
  /**
   * Refresh enabled, usage-capable provider instances. Concurrent callers join
   * the same per-instance probe; provider failures are isolated and logged.
   *
   * Returns the instances that yielded a fresh payload on this call, so callers
   * can tell an all-probes-failed refresh from a successful one without
   * second-guessing snapshot timestamps.
   */
  readonly refresh: (
    instanceIds?: ReadonlyArray<ProviderInstanceId>,
  ) => Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
}

export class ProviderUsageRefresh extends Context.Service<
  ProviderUsageRefresh,
  ProviderUsageRefreshShape
>()("t3/provider/Services/ProviderUsageRefresh") {}
