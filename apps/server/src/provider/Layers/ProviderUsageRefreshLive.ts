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
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import {
  CLIPROXYAPI_USAGE_SOURCE_KIND,
  makeCliProxyApiUsageProbe,
  resolveCliProxyApiUsageProbeTarget,
  type CliProxyApiUsageProbeTarget,
} from "../cliProxyApiUsage.ts";
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

interface UsageProbeOutcome {
  /** Whether the probe reported a fresh payload. */
  readonly refreshed: boolean;
  /** Present when the probe errored with a message worth showing a user. */
  readonly failureReason?: string;
}

interface InFlightUsageProbe {
  readonly adapter: UsageRefreshProviderInstance["adapter"];
  readonly completion: Deferred.Deferred<UsageProbeOutcome>;
}

const MAX_CONCURRENT_USAGE_PROBES = 3;
const USAGE_PROBE_TIMEOUT = "30 seconds";

/** Best user-facing sentence hiding in a probe's failure cause. */
function probeFailureReason(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  if (Cause.isTimeoutError(squashed)) return "The usage probe timed out.";
  if (typeof squashed === "object" && squashed !== null) {
    // Adapter errors carry their human-readable sentence in `detail`; the
    // `message` getter prefixes it with provider/method plumbing.
    const detail = (squashed as { readonly detail?: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
    const message = (squashed as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The usage probe failed.";
}

export const makeProviderUsageRefresh = Effect.fn("makeProviderUsageRefresh")(function* (
  dependencies: ProviderUsageRefreshDependencies,
) {
  const serverScope = yield* Scope.Scope;
  const probeGate = yield* Semaphore.make(MAX_CONCURRENT_USAGE_PROBES);
  const inFlight = yield* Ref.make<ReadonlyMap<ProviderInstanceId, InFlightUsageProbe>>(new Map());

  const runProbe = (
    instance: UsageRefreshProviderInstance,
    completion: Deferred.Deferred<UsageProbeOutcome>,
    outcome: Ref.Ref<UsageProbeOutcome>,
  ) =>
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
            yield* Ref.set(outcome, { refreshed: true });
          }
        }).pipe(Effect.timeout(USAGE_PROBE_TIMEOUT)),
      )
      .pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          return Ref.set(outcome, {
            refreshed: false,
            failureReason: probeFailureReason(cause),
          }).pipe(
            Effect.andThen(
              Effect.logWarning("Failed to refresh provider usage for instance.", {
                instanceId: instance.instanceId,
                driver: instance.driverKind,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }),
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Ref.update(inFlight, (current) => {
              if (current.get(instance.instanceId)?.completion !== completion) return current;
              const next = new Map(current);
              next.delete(instance.instanceId);
              return next;
            });
            yield* Deferred.succeed(completion, yield* Ref.get(outcome));
          }),
        ),
      );

  const refreshInstance = (instance: UsageRefreshProviderInstance) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<UsageProbeOutcome>();
        const outcome = yield* Ref.make<UsageProbeOutcome>({ refreshed: false });
        const registration = yield* Ref.modify(inFlight, (current) => {
          const existing = current.get(instance.instanceId);
          if (existing !== undefined && existing.adapter === instance.adapter) {
            const joined: {
              readonly completion: Deferred.Deferred<UsageProbeOutcome>;
              readonly owner: boolean;
            } = { completion: existing.completion, owner: false };
            return [joined, current] as const;
          }
          const owned: {
            readonly completion: Deferred.Deferred<UsageProbeOutcome>;
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
          yield* runProbe(instance, registration.completion, outcome).pipe(
            Effect.forkIn(serverScope),
          );
        }
        return yield* restore(Deferred.await(registration.completion));
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

      const outcomes = yield* Effect.forEach(
        instances,
        (instance) =>
          refreshInstance(instance).pipe(
            Effect.map((outcome) => ({ instanceId: instance.instanceId, ...outcome })),
          ),
        { concurrency: "unbounded" },
      );
      return {
        refreshedInstanceIds: outcomes
          .filter((outcome) => outcome.refreshed)
          .map((outcome) => outcome.instanceId),
        failures: outcomes.flatMap((outcome) =>
          outcome.failureReason !== undefined
            ? [{ instanceId: outcome.instanceId, reason: outcome.failureReason }]
            : [],
        ),
      };
    },
  );

  return { refresh } satisfies ProviderUsageRefreshShape;
});

export const ProviderUsageRefreshLive = Layer.effect(
  ProviderUsageRefresh,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    const health = yield* ProviderInstanceHealth;
    const httpClient = yield* HttpClient.HttpClient;

    // Gateway probes are memoized per instance: the coordinator's
    // single-flight join compares adapters by identity, and the probe closure
    // holds auth-failure cooldown state that must survive across refreshes.
    const gatewayProbes = new Map<
      ProviderInstanceId,
      {
        readonly target: CliProxyApiUsageProbeTarget;
        readonly adapter: UsageRefreshProviderInstance["adapter"];
      }
    >();

    const gatewayAdapterFor = (
      instanceId: ProviderInstanceId,
      target: CliProxyApiUsageProbeTarget,
    ): UsageRefreshProviderInstance["adapter"] => {
      const cached = gatewayProbes.get(instanceId);
      if (
        cached &&
        cached.target.managementUrl === target.managementUrl &&
        cached.target.managementKey === target.managementKey &&
        cached.target.clientKey === target.clientKey
      ) {
        return cached.adapter;
      }
      const probe = makeCliProxyApiUsageProbe(target);
      const adapter: UsageRefreshProviderInstance["adapter"] = {
        readAccountUsage: () =>
          probe().pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
      };
      gatewayProbes.set(instanceId, { target, adapter });
      return adapter;
    };

    const listInstances: Effect.Effect<ReadonlyArray<UsageRefreshProviderInstance>> = Effect.gen(
      function* () {
        const instances = yield* registry.listInstances;
        const resolved: Array<UsageRefreshProviderInstance> = [];
        const activeGatewayProbeIds = new Set<ProviderInstanceId>();
        for (const instance of instances) {
          const envelope = yield* (
            registry.getInstanceConfig?.(instance.instanceId) ?? Effect.succeed(undefined)
          );
          // Gate on the *recognized* kind, not mere presence: the contract
          // promises a build that does not know a kind leaves the envelope
          // alone and keeps the driver's own usage working.
          if (envelope?.usageSource?.kind !== CLIPROXYAPI_USAGE_SOURCE_KIND) {
            resolved.push(instance);
            continue;
          }
          // An instance that declares a usage source never falls back to the
          // driver's own probe: through a gateway that probe reports either
          // nothing or, worse, whatever unrelated account the config home is
          // logged into.
          const target = resolveCliProxyApiUsageProbeTarget(envelope);
          if (target) {
            activeGatewayProbeIds.add(instance.instanceId);
          }
          resolved.push({
            instanceId: instance.instanceId,
            driverKind: instance.driverKind,
            enabled: instance.enabled,
            adapter: target ? gatewayAdapterFor(instance.instanceId, target) : {},
          });
        }
        // Sweeping by the active set subsumes any per-instance pruning above:
        // an id only enters `gatewayProbes` via `gatewayAdapterFor`, which
        // runs exactly for the ids in that set.
        for (const instanceId of gatewayProbes.keys()) {
          if (!activeGatewayProbeIds.has(instanceId)) {
            gatewayProbes.delete(instanceId);
          }
        }
        return resolved;
      },
    );

    // A gateway snapshot outlives its source: turning the usage source off
    // makes the instance fall back to the driver's SDK probe, which reports
    // nothing through a gateway, so nothing would ever overwrite the pooled
    // payload. Watch registry reconciles and drop the snapshot the moment an
    // instance's resolved gateway target disappears or changes. The clear
    // carries a fresh observation token so a probe already in flight against
    // the old source cannot re-install what it read.
    const resolveGatewayTargets = Effect.gen(function* () {
      const targets = new Map<ProviderInstanceId, string>();
      for (const instance of yield* registry.listInstances) {
        const envelope = yield* (
          registry.getInstanceConfig?.(instance.instanceId) ?? Effect.succeed(undefined)
        );
        if (envelope?.usageSource?.kind !== CLIPROXYAPI_USAGE_SOURCE_KIND) continue;
        const target = resolveCliProxyApiUsageProbeTarget(envelope);
        if (target) {
          targets.set(instance.instanceId, `${target.managementUrl} ${target.managementKey}`);
        }
      }
      return targets;
    });
    // Subscribe before the initial read so a reconcile landing in between
    // still produces an event that re-diffs.
    const registryChanges = yield* registry.subscribeChanges;
    const knownGatewayTargets = yield* Ref.make(yield* resolveGatewayTargets);
    yield* Stream.runForEach(Stream.fromSubscription(registryChanges), () =>
      Effect.gen(function* () {
        const next = yield* resolveGatewayTargets;
        const previous = yield* Ref.getAndSet(knownGatewayTargets, next);
        for (const [instanceId, targetKey] of previous) {
          if (next.get(instanceId) !== targetKey) {
            yield* health.clearUsageSnapshot(instanceId, yield* health.beginUsageObservation());
          }
        }
      }),
    ).pipe(Effect.forkScoped);

    return yield* makeProviderUsageRefresh({
      listInstances,
      health,
    });
  }),
);
