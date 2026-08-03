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
  DRIVER_USAGE_SOURCE_KEY,
  makeUsageSourceKey,
  ProviderInstanceHealth,
  type ProviderInstanceHealthShape,
  type UsageSourceKey,
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
  readonly usageSourceKey: UsageSourceKey;
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
  readonly usageSourceKey: UsageSourceKey;
}

interface InFlightRegistration {
  readonly completion: Deferred.Deferred<UsageProbeOutcome>;
  readonly kind: "join" | "owner" | "wait";
}

const MAX_CONCURRENT_USAGE_PROBES = 3;
const USAGE_PROBE_TIMEOUT = "30 seconds";
const UNRESOLVED_GATEWAY_USAGE_SOURCE_KEY = makeUsageSourceKey();

function sameGatewayTarget(
  left: CliProxyApiUsageProbeTarget | undefined,
  right: CliProxyApiUsageProbeTarget | undefined,
): boolean {
  return (
    left?.managementUrl === right?.managementUrl && left?.managementKey === right?.managementKey
  );
}

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
          // The adapter was selected before this probe entered the bounded
          // gate. Re-resolve after acquiring a permit so an adapter whose
          // source changed while queued cannot start against stale config.
          const current = (yield* dependencies.listInstances).find(
            (candidate) => candidate.instanceId === instance.instanceId,
          );
          if (
            current?.enabled !== true ||
            current.adapter !== instance.adapter ||
            current.usageSourceKey !== instance.usageSourceKey ||
            current.adapter.readAccountUsage === undefined
          ) {
            return;
          }
          const observationToken = yield* dependencies.health.beginUsageObservation();
          const observedAt = yield* Clock.currentTimeMillis;
          const payload = yield* instance.adapter.readAccountUsage!();
          if (payload !== undefined) {
            const stored = yield* dependencies.health.reportUsageSnapshot(
              instance.instanceId,
              payload,
              observedAt,
              observationToken,
              instance.usageSourceKey,
            );
            if (stored) {
              yield* Ref.set(outcome, { refreshed: true });
            }
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

  const refreshInstance = (
    instance: UsageRefreshProviderInstance,
  ): Effect.Effect<UsageProbeOutcome> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<UsageProbeOutcome>();
        const outcome = yield* Ref.make<UsageProbeOutcome>({ refreshed: false });
        const registration = yield* Ref.modify(
          inFlight,
          (
            current,
          ): readonly [
            InFlightRegistration,
            ReadonlyMap<ProviderInstanceId, InFlightUsageProbe>,
          ] => {
            const existing = current.get(instance.instanceId);
            if (existing !== undefined) {
              const joined: InFlightRegistration = {
                completion: existing.completion,
                kind:
                  existing.adapter === instance.adapter &&
                  existing.usageSourceKey === instance.usageSourceKey
                    ? "join"
                    : "wait",
              };
              return [joined, current] as const;
            }
            const owned: InFlightRegistration = { completion: candidate, kind: "owner" };
            return [
              owned,
              new Map(current).set(instance.instanceId, {
                adapter: instance.adapter,
                completion: candidate,
                usageSourceKey: instance.usageSourceKey,
              }),
            ] as const;
          },
        );

        if (registration.kind === "owner") {
          yield* runProbe(instance, registration.completion, outcome).pipe(
            Effect.forkIn(serverScope),
          );
        }
        const completed = yield* restore(Deferred.await(registration.completion));
        if (registration.kind === "wait") {
          return yield* restore(Effect.suspend(() => refreshInstance(instance)));
        }
        return completed;
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
        readonly sourceKey: UsageSourceKey;
      }
    >();

    const gatewayProbeFor = (
      instanceId: ProviderInstanceId,
      target: CliProxyApiUsageProbeTarget,
    ): {
      readonly adapter: UsageRefreshProviderInstance["adapter"];
      readonly sourceKey: UsageSourceKey;
    } => {
      const cached = gatewayProbes.get(instanceId);
      if (cached && sameGatewayTarget(cached.target, target)) {
        return cached;
      }
      const probe = makeCliProxyApiUsageProbe(target);
      const adapter: UsageRefreshProviderInstance["adapter"] = {
        readAccountUsage: () =>
          probe().pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
      };
      const created = { target, adapter, sourceKey: makeUsageSourceKey() };
      gatewayProbes.set(instanceId, created);
      return created;
    };

    const resolveUsageInstances = Effect.gen(function* () {
      const instances = yield* registry.listInstances;
      const resolved: Array<UsageRefreshProviderInstance> = [];
      const activeGatewayProbeIds = new Set<ProviderInstanceId>();
      for (const instance of instances) {
        const sourceObservationToken = yield* health.beginUsageObservation();
        const envelope = yield* (
          registry.getInstanceConfig?.(instance.instanceId) ?? Effect.succeed(undefined)
        );
        // Gate on the *recognized* kind, not mere presence: the contract
        // promises a build that does not know a kind leaves the envelope
        // alone and keeps the driver's own usage working.
        if (envelope?.usageSource?.kind !== CLIPROXYAPI_USAGE_SOURCE_KIND) {
          yield* health.setUsageSource(
            instance.instanceId,
            DRIVER_USAGE_SOURCE_KEY,
            sourceObservationToken,
          );
          resolved.push({
            instanceId: instance.instanceId,
            driverKind: instance.driverKind,
            enabled: instance.enabled,
            adapter: instance.adapter,
            usageSourceKey: DRIVER_USAGE_SOURCE_KEY,
          });
          continue;
        }
        // An instance that declares a usage source never falls back to the
        // driver's own probe: through a gateway that probe reports either
        // nothing or, worse, whatever unrelated account the config home is
        // logged into.
        const target = resolveCliProxyApiUsageProbeTarget(envelope);
        const gatewayProbe = target ? gatewayProbeFor(instance.instanceId, target) : undefined;
        if (target) {
          activeGatewayProbeIds.add(instance.instanceId);
        }
        const usageSourceKey = gatewayProbe?.sourceKey ?? UNRESOLVED_GATEWAY_USAGE_SOURCE_KEY;
        yield* health.setUsageSource(instance.instanceId, usageSourceKey, sourceObservationToken);
        resolved.push({
          instanceId: instance.instanceId,
          driverKind: instance.driverKind,
          enabled: instance.enabled,
          adapter: gatewayProbe?.adapter ?? {},
          usageSourceKey,
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
    });

    // A gateway snapshot outlives its source: turning the usage source off
    // makes the instance fall back to the driver's SDK probe, which reports
    // nothing through a gateway, so nothing would ever overwrite the pooled
    // payload. Watch registry reconciles and drop the snapshot the moment an
    // instance's resolved gateway target disappears or changes. The clear
    // is source-aware, so a delayed reconcile preserves a snapshot already
    // reported by the new source while rejecting writes from the old one.
    // Subscribe before the initial read so a reconcile landing in between
    // still produces an event that re-declares the current sources.
    const registryChanges = yield* registry.subscribeChanges;
    yield* resolveUsageInstances;
    const targetReconcileGate = yield* Semaphore.make(1);
    const listInstances: Effect.Effect<ReadonlyArray<UsageRefreshProviderInstance>> =
      targetReconcileGate.withPermits(1)(resolveUsageInstances);
    yield* Stream.runForEach(Stream.fromSubscription(registryChanges), () =>
      listInstances.pipe(Effect.asVoid),
    ).pipe(Effect.forkScoped);

    return yield* makeProviderUsageRefresh({
      listInstances,
      health,
    });
  }),
);
