import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderUsageRefreshShape {
  /**
   * Refresh enabled, usage-capable provider instances. Concurrent callers join
   * the same per-instance probe; provider failures are isolated and logged.
   */
  readonly refresh: (instanceIds?: ReadonlyArray<ProviderInstanceId>) => Effect.Effect<void>;
}

export class ProviderUsageRefresh extends Context.Service<
  ProviderUsageRefresh,
  ProviderUsageRefreshShape
>()("t3/provider/Services/ProviderUsageRefresh") {}
