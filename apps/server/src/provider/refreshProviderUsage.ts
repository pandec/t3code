/**
 * Best-effort subscription-usage refresh across provider instances.
 *
 * The coordinator owns cross-instance guardrails only. Provider-specific
 * process and protocol choices stay behind the optional adapter method.
 */
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import type { ProviderAdapterError } from "./Errors.ts";
import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";
import type { ProviderInstanceHealthShape } from "./Services/ProviderInstanceHealth.ts";

export interface UsageRefreshProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly enabled: boolean;
  readonly adapter: Pick<ProviderAdapterShape<ProviderAdapterError>, "readAccountUsage">;
}

export interface RefreshProviderUsageDependencies {
  readonly listInstances: Effect.Effect<ReadonlyArray<UsageRefreshProviderInstance>>;
  readonly health: Pick<ProviderInstanceHealthShape, "reportUsageSnapshot">;
}

export const refreshProviderUsageSnapshots = Effect.fn("refreshProviderUsageSnapshots")(function* (
  dependencies: RefreshProviderUsageDependencies,
  requestedInstanceIds?: ReadonlyArray<ProviderInstanceId>,
) {
  const requested =
    requestedInstanceIds === undefined
      ? undefined
      : new Set<ProviderInstanceId>(requestedInstanceIds);
  const instances = (yield* dependencies.listInstances).filter(
    (instance) =>
      instance.enabled &&
      instance.adapter.readAccountUsage !== undefined &&
      (requested === undefined || requested.has(instance.instanceId)),
  );

  yield* Effect.forEach(
    instances,
    (instance) =>
      Effect.gen(function* () {
        const payload = yield* instance.adapter.readAccountUsage!();
        if (payload !== undefined) {
          yield* dependencies.health.reportUsageSnapshot(instance.instanceId, payload);
        }
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          return Effect.logWarning("Failed to refresh provider usage for instance.", {
            instanceId: instance.instanceId,
            driver: instance.driverKind,
            cause: Cause.pretty(cause),
          });
        }),
      ),
    { concurrency: 3, discard: true },
  );
});
