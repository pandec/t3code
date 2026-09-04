/**
 * ProviderUsageLimitsIngestionLive — folds `account.rate-limits.updated`
 * runtime events into the owning instance's published snapshot.
 *
 * Adapters normalise their native payloads before emitting, so this layer
 * never sees a driver shape: it routes the typed update to the instance and
 * lets `ServerProviderShape.applyUsageLimits` merge and republish on the
 * instance's own change stream, which `ProviderRegistry` already aggregates.
 *
 * @module provider/Layers/ProviderUsageLimitsIngestion
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { CLIPROXYAPI_USAGE_SOURCE_KIND } from "../cliProxyApiUsage.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";

export const ProviderUsageLimitsIngestionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const instanceRegistry = yield* ProviderInstanceRegistry;

    yield* providerService.streamEvents.pipe(
      Stream.filter((event) => event.type === "account.rate-limits.updated"),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (!event.providerInstanceId) {
            return;
          }
          // Raw-only events (typed normalisation failed) still feed the fork's
          // failover and usage-snapshot path in ProviderRuntimeIngestion; only
          // the typed half belongs to the provider snapshot.
          const limits = event.payload.limits;
          if (limits === undefined) {
            return;
          }
          // A gateway pool owns the instance's usage slot (see the fork's
          // ProviderRuntimeIngestion gate): a passive single-account event
          // forwarded through CLIProxyAPI must not become the typed answer.
          const instanceConfig = yield* (
            instanceRegistry.getInstanceConfig?.(event.providerInstanceId) ??
              Effect.succeed(undefined)
          );
          if (instanceConfig?.usageSource?.kind === CLIPROXYAPI_USAGE_SOURCE_KIND) {
            return;
          }
          const instance = yield* instanceRegistry.getInstance(event.providerInstanceId);
          if (!instance) {
            return;
          }
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          yield* instance.snapshot.applyUsageLimits({ ...limits, checkedAt });
          // One bad event must not end the subscriber for every later one.
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.forkScoped,
    );
  }),
);
