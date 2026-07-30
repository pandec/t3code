/**
 * Server-wide subscription-usage refresh coordinator.
 *
 * The service owns cross-client concurrency and per-instance single-flight.
 * Provider-specific process and protocol choices stay behind the optional
 * adapter method.
 */
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ProviderInstanceHealth,
  type ProviderInstanceHealthShape,
} from "../Services/ProviderInstanceHealth.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderUsageRefresh,
  type ProviderUsageRefreshShape,
} from "../Services/ProviderUsageRefresh.ts";

export interface UsageRefreshProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly enabled: boolean;
  readonly adapter: Pick<ProviderAdapterShape<ProviderAdapterError>, "readAccountUsage">;
}

export interface ProviderUsageRefreshDependencies {
  readonly listInstances: Effect.Effect<ReadonlyArray<UsageRefreshProviderInstance>>;
  readonly health: Pick<
    ProviderInstanceHealthShape,
    "beginUsageObservation" | "reportUsageSnapshot"
  >;
}

interface InFlightUsageProbe {
  readonly adapter: UsageRefreshProviderInstance["adapter"];
  readonly completion: Deferred.Deferred<void>;
}

const MAX_CONCURRENT_USAGE_PROBES = 3;
const USAGE_PROBE_TIMEOUT = "30 seconds";

export const makeProviderUsageRefresh = Effect.fn("makeProviderUsageRefresh")(function* (
  dependencies: ProviderUsageRefreshDependencies,
) {
  const serverScope = yield* Scope.Scope;
  const probeGate = yield* Semaphore.make(MAX_CONCURRENT_USAGE_PROBES);
  const inFlight = yield* Ref.make<ReadonlyMap<ProviderInstanceId, InFlightUsageProbe>>(new Map());

  const runProbe = (instance: UsageRefreshProviderInstance, completion: Deferred.Deferred<void>) =>
    probeGate
      .withPermits(1)(
        Effect.gen(function* () {
          const observationToken = yield* dependencies.health.beginUsageObservation();
          const observedAt = yield* Clock.currentTimeMillis;
          const payload = yield* instance.adapter.readAccountUsage!();
          if (payload !== undefined) {
            yield* dependencies.health.reportUsageSnapshot(
              instance.instanceId,
              payload,
              observedAt,
              observationToken,
            );
          }
        }).pipe(Effect.timeout(USAGE_PROBE_TIMEOUT)),
      )
      .pipe(
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
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Ref.update(inFlight, (current) => {
              if (current.get(instance.instanceId)?.completion !== completion) return current;
              const next = new Map(current);
              next.delete(instance.instanceId);
              return next;
            });
            yield* Deferred.succeed(completion, undefined);
          }),
        ),
      );

  const refreshInstance = (instance: UsageRefreshProviderInstance) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<void>();
        const registration = yield* Ref.modify(inFlight, (current) => {
          const existing = current.get(instance.instanceId);
          if (existing !== undefined && existing.adapter === instance.adapter) {
            const joined: {
              readonly completion: Deferred.Deferred<void>;
              readonly owner: boolean;
            } = { completion: existing.completion, owner: false };
            return [joined, current] as const;
          }
          const owned: {
            readonly completion: Deferred.Deferred<void>;
            readonly owner: boolean;
          } = { completion: candidate, owner: true };
          return [
            owned,
            new Map(current).set(instance.instanceId, {
              adapter: instance.adapter,
              completion: candidate,
            }),
          ] as const;
        });

        if (registration.owner) {
          yield* runProbe(instance, registration.completion).pipe(Effect.forkIn(serverScope));
        }
        yield* restore(Deferred.await(registration.completion));
      }),
    );

  const refresh: ProviderUsageRefreshShape["refresh"] = Effect.fn("ProviderUsageRefresh.refresh")(
    function* (requestedInstanceIds) {
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

      yield* Effect.forEach(instances, refreshInstance, {
        concurrency: "unbounded",
        discard: true,
      });
    },
  );

  return { refresh } satisfies ProviderUsageRefreshShape;
});

export const ProviderUsageRefreshLive = Layer.effect(
  ProviderUsageRefresh,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    const health = yield* ProviderInstanceHealth;
    return yield* makeProviderUsageRefresh({
      listInstances: registry.listInstances,
      health,
    });
  }),
);
