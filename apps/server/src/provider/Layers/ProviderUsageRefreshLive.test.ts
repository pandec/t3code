import { beforeEach, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { resetCliProxyApiAuthFailuresForTest } from "../cliProxyApiUsage.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import {
  DRIVER_USAGE_SOURCE_KEY,
  makeUsageSourceKey,
  ProviderInstanceHealth,
  type UsageObservationToken,
  type UsageSourceKey,
} from "../Services/ProviderInstanceHealth.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderUsageRefresh } from "../Services/ProviderUsageRefresh.ts";
import { makeProviderInstanceHealth } from "./ProviderInstanceHealthLive.ts";
import {
  makeProviderUsageRefresh,
  ProviderUsageRefreshLive,
  type ProviderUsageRefreshDependencies,
  type UsageRefreshProviderInstance,
} from "./ProviderUsageRefreshLive.ts";

const driver = ProviderDriverKind.make("claudeAgent");

// The auth-failure strike ledger is process-wide and keyed by gateway origin;
// without a reset the gateway tests would inherit each other's strikes.
beforeEach(() => {
  resetCliProxyApiAuthFailuresForTest();
});

function instance(input: {
  readonly id: string;
  readonly enabled?: boolean;
  readonly read?: Effect.Effect<unknown | undefined, ProviderAdapterError>;
  readonly onRead?: () => void;
  readonly usageSourceKey?: UsageSourceKey;
}): UsageRefreshProviderInstance {
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driverKind: driver,
    enabled: input.enabled ?? true,
    usageSourceKey: input.usageSourceKey ?? DRIVER_USAGE_SOURCE_KEY,
    adapter:
      input.read !== undefined || input.onRead !== undefined
        ? {
            readAccountUsage: () =>
              Effect.sync(() => input.onRead?.()).pipe(
                Effect.andThen(input.read ?? Effect.succeed({ id: input.id })),
              ),
          }
        : {},
  };
}

function usageHealth(
  reportUsageSnapshot: ProviderUsageRefreshDependencies["health"]["reportUsageSnapshot"] = () =>
    Effect.succeed(true),
): ProviderUsageRefreshDependencies["health"] {
  let nextToken = 0;
  return {
    beginUsageObservation: () =>
      Effect.sync(() => {
        nextToken += 1;
        return nextToken as UsageObservationToken;
      }),
    reportUsageSnapshot,
  };
}

it.effect("reuses gateway cooldown state, prunes removed probes, and never falls back", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = ProviderInstanceId.make("claude_gateway");
      const config = yield* Ref.make<ProviderInstanceConfig>({
        driver,
        environment: [
          {
            name: "ANTHROPIC_BASE_URL",
            value: "https://gateway.example.test/v1",
            sensitive: false,
          },
        ],
        usageSource: { kind: "cliproxyapi", managementKey: "management-key" },
        config: {},
      });
      const directReads = yield* Ref.make(0);
      const gatewayRequests = yield* Ref.make(0);
      const directInstance = {
        instanceId: target,
        driverKind: driver,
        enabled: true,
        adapter: {
          readAccountUsage: () =>
            Ref.update(directReads, (count) => count + 1).pipe(Effect.as({ source: "direct-sdk" })),
        },
      } as unknown as ProviderInstance;
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([directInstance]);
      const registryLayer = Layer.succeed(ProviderInstanceRegistry, {
        getInstance: (instanceId) =>
          Effect.succeed(instanceId === target ? directInstance : undefined),
        getInstanceConfig: (instanceId) =>
          instanceId === target
            ? Ref.get(config)
            : Effect.succeed<ProviderInstanceConfig | undefined>(undefined),
        listInstances: Ref.get(instances),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      });
      const healthLayer = Layer.effect(ProviderInstanceHealth, makeProviderInstanceHealth);
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(gatewayRequests, (count) => count + 1).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }))),
          ),
        ),
      );
      const layer = ProviderUsageRefreshLive.pipe(
        Layer.provide(registryLayer),
        Layer.provide(healthLayer),
        Layer.provide(httpLayer),
      );

      yield* Effect.gen(function* () {
        const refresh = yield* ProviderUsageRefresh;

        const rejected = yield* refresh.refresh([target]);
        expect(rejected.refreshedInstanceIds).toEqual([]);
        expect(rejected.failures[0]?.reason).toContain("authentication rejected");
        expect(yield* Ref.get(gatewayRequests)).toBe(1);
        // The cooled-down probe fails locally, with the pause as the reason.
        const cooled = yield* refresh.refresh([target]);
        expect(cooled.refreshedInstanceIds).toEqual([]);
        expect(cooled.failures[0]?.reason).toContain("paused");
        expect(yield* Ref.get(gatewayRequests)).toBe(1);

        // Removing an instance prunes the memoized probe, but the gateway's
        // auth-failure cooldown is tracked per origin, not per closure: a
        // rebuilt instance must not hand the user a fresh set of ban strikes.
        yield* Ref.set(instances, []);
        yield* refresh.refresh();
        yield* Ref.set(instances, [directInstance]);
        expect((yield* refresh.refresh([target])).refreshedInstanceIds).toEqual([]);
        expect(yield* Ref.get(gatewayRequests)).toBe(1);

        // A declared but unresolved source owns the usage slot and must not
        // silently restore the SDK adapter.
        yield* Ref.update(config, (current) => ({
          ...current,
          usageSource: { kind: "cliproxyapi", managementKey: "" },
        }));
        expect(yield* refresh.refresh([target])).toEqual({
          refreshedInstanceIds: [],
          failures: [],
        });
        expect(yield* Ref.get(directReads)).toBe(0);
        expect(yield* Ref.get(gatewayRequests)).toBe(1);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("reconciles usage-source transitions before refreshes and registry events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = ProviderInstanceId.make("claude_gateway");
      const environment = [
        {
          name: "ANTHROPIC_BASE_URL",
          value: "https://gateway.example.test/v1",
          sensitive: false,
        },
      ];
      const gatewayConfig: ProviderInstanceConfig = {
        driver,
        environment,
        usageSource: { kind: "cliproxyapi", managementKey: "management-key" },
        config: {},
      };
      const config = yield* Ref.make<ProviderInstanceConfig>(gatewayConfig);
      const nextConfigRead = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
      const changes = yield* PubSub.unbounded<void>();
      const gatewayInstance = {
        instanceId: target,
        driverKind: driver,
        enabled: true,
        adapter: {},
      } as unknown as ProviderInstance;
      const registryLayer = Layer.succeed(ProviderInstanceRegistry, {
        getInstance: (instanceId) =>
          Effect.succeed(instanceId === target ? gatewayInstance : undefined),
        getInstanceConfig: (instanceId) =>
          instanceId === target
            ? Ref.get(config).pipe(
                Effect.tap(() =>
                  Ref.getAndSet(nextConfigRead, undefined).pipe(
                    Effect.flatMap((waiter) =>
                      waiter === undefined ? Effect.void : Deferred.succeed(waiter, undefined),
                    ),
                  ),
                ),
              )
            : Effect.succeed<ProviderInstanceConfig | undefined>(undefined),
        listInstances: Effect.succeed([gatewayInstance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes),
      });
      const healthLayer = Layer.effect(ProviderInstanceHealth, makeProviderInstanceHealth);
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  files: [{ auth_index: "pool", name: "pool.json", provider: "unknown" }],
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            ),
          ),
        ),
      );
      const layer = ProviderUsageRefreshLive.pipe(
        Layer.provide(registryLayer),
        Layer.provideMerge(healthLayer),
        Layer.provide(httpLayer),
      );

      yield* Effect.gen(function* () {
        const refresh = yield* ProviderUsageRefresh;
        const health = yield* ProviderInstanceHealth;

        expect((yield* refresh.refresh([target])).refreshedInstanceIds).toEqual([target]);
        expect(yield* health.listUsageSnapshots()).toHaveLength(1);

        // Passive ingestion can observe the new direct source before the
        // registry watcher drains. Declaring the source at the write edge
        // keeps that valid payload through the delayed notification.
        const removalObserved = yield* Deferred.make<void>();
        yield* Ref.set(nextConfigRead, removalObserved);
        yield* Ref.set(config, { driver, environment, config: {} });
        const directToken = yield* health.beginUsageObservation();
        yield* health.setUsageSource(target, DRIVER_USAGE_SOURCE_KEY, directToken);
        expect(
          yield* health.reportUsageSnapshot(
            target,
            { source: "direct" },
            2_000,
            directToken,
            DRIVER_USAGE_SOURCE_KEY,
          ),
        ).toBe(true);
        yield* PubSub.publish(changes, undefined);
        yield* Deferred.await(removalObserved);
        // The refresh joins behind the watcher's reconciliation gate, giving
        // this test a receipt-like boundary without polling the snapshot.
        yield* refresh.refresh([target]);
        expect(yield* health.listUsageSnapshots()).toEqual([
          { instanceId: target, payload: { source: "direct" }, observedAt: 2_000 },
        ]);

        // Declaring an unresolved gateway still owns the slot and must clear
        // the direct payload even though it has no adapter capable of probing.
        yield* Ref.set(config, {
          ...gatewayConfig,
          usageSource: { kind: "cliproxyapi", managementKey: "" },
        });
        expect(yield* refresh.refresh([target])).toEqual({
          refreshedInstanceIds: [],
          failures: [],
        });
        expect(yield* health.listUsageSnapshots()).toEqual([]);

        // A refresh can observe the replacement gateway before its registry
        // event is drained. The delayed declaration is idempotent and must not
        // later clear the valid replacement-source snapshot.
        yield* Ref.set(config, {
          ...gatewayConfig,
          usageSource: { kind: "cliproxyapi", managementKey: "replacement-key" },
        });
        expect((yield* refresh.refresh([target])).refreshedInstanceIds).toEqual([target]);
        expect(yield* health.listUsageSnapshots()).toHaveLength(1);

        const additionObserved = yield* Deferred.make<void>();
        yield* Ref.set(nextConfigRead, additionObserved);
        yield* PubSub.publish(changes, undefined);
        yield* Deferred.await(additionObserved);
        yield* refresh.refresh([target]);
        expect(yield* health.listUsageSnapshots()).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("skips disabled and unsupported instances", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reads: string[] = [];
      const instances = [
        instance({ id: "claude_disabled", enabled: false, onRead: () => reads.push("disabled") }),
        instance({ id: "claude_unsupported" }),
        instance({ id: "claude_idle", onRead: () => reads.push("idle") }),
      ];
      const reports = yield* Ref.make<ReadonlyArray<string>>([]);
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Effect.succeed(instances),
        health: usageHealth((instanceId) =>
          Ref.update(reports, (current) => [...current, instanceId]).pipe(Effect.as(true)),
        ),
      });

      yield* coordinator.refresh();

      expect(reads).toEqual(["idle"]);
      expect(yield* Ref.get(reports)).toEqual(["claude_idle"]);
    }),
  ),
);

it.effect("skips reporting when the adapter has no usage payload", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reports = yield* Ref.make<ReadonlyArray<string>>([]);
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Effect.succeed([instance({ id: "claude_empty", read: Effect.void })]),
        health: usageHealth((instanceId) =>
          Ref.update(reports, (current) => [...current, instanceId]).pipe(Effect.as(true)),
        ),
      });

      yield* coordinator.refresh();

      expect(yield* Ref.get(reports)).toEqual([]);
    }),
  ),
);

it.effect("isolates one instance failure and continues refreshing siblings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reports = yield* Ref.make<ReadonlyArray<string>>([]);
      const failure = Effect.fail({
        _tag: "ProviderAdapterError",
        message: "simulated failure",
      } as unknown as ProviderAdapterError);
      const instances = [
        instance({ id: "claude_broken", read: failure }),
        instance({ id: "claude_healthy", read: Effect.succeed({ used: 12 }) }),
      ];
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Effect.succeed(instances),
        health: usageHealth((instanceId) =>
          Ref.update(reports, (current) => [...current, instanceId]).pipe(Effect.as(true)),
        ),
      });

      yield* coordinator.refresh();

      expect(yield* Ref.get(reports)).toEqual(["claude_healthy"]);
    }),
  ),
);

it.effect("clears a failed probe so a later refresh can retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const reports = yield* Ref.make(0);
      const target = ProviderInstanceId.make("claude_retry");
      const failure = {
        _tag: "ProviderAdapterError",
        message: "simulated first-attempt failure",
      } as unknown as ProviderAdapterError;
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Effect.succeed([
          instance({
            id: target,
            read: Ref.updateAndGet(attempts, (count) => count + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt === 1 ? Effect.fail(failure) : Effect.succeed({ used: 12 }),
              ),
            ),
          }),
        ]),
        health: usageHealth(() => Ref.update(reports, (count) => count + 1).pipe(Effect.as(true))),
      });

      yield* coordinator.refresh([target]);
      yield* coordinator.refresh([target]);

      expect(yield* Ref.get(attempts)).toBe(2);
      expect(yield* Ref.get(reports)).toBe(1);
    }),
  ),
);

it.effect("honors an explicit instance-id subset", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reads: string[] = [];
      const target = ProviderInstanceId.make("claude_target");
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Effect.succeed([
          instance({ id: target, onRead: () => reads.push("target") }),
          instance({ id: "claude_other", onRead: () => reads.push("other") }),
        ]),
        health: usageHealth(),
      });

      yield* coordinator.refresh([target]);

      expect(reads).toEqual(["target"]);
    }),
  ),
);

it.effect("caps concurrent provider reads at three across refresh calls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseReads = yield* Deferred.make<void>();
      const threeStarted = yield* Deferred.make<void>();
      const current = yield* Ref.make(0);
      const maximum = yield* Ref.make(0);
      const read = Effect.gen(function* () {
        const active = yield* Ref.updateAndGet(current, (value) => value + 1);
        yield* Ref.update(maximum, (value) => Math.max(value, active));
        if (active === 3) {
          yield* Deferred.succeed(threeStarted, undefined);
        }
        yield* Deferred.await(releaseReads);
        yield* Ref.update(current, (value) => value - 1);
        return { used: 1 };
      });
      const instances = Array.from({ length: 6 }, (_, index) =>
        instance({ id: `claude_${index}`, read }),
      );
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Effect.succeed(instances),
        health: usageHealth(),
      });

      const first = yield* coordinator
        .refresh(instances.slice(0, 3).map(({ instanceId }) => instanceId))
        .pipe(Effect.forkChild);
      const second = yield* coordinator
        .refresh(instances.slice(3).map(({ instanceId }) => instanceId))
        .pipe(Effect.forkChild);
      yield* Deferred.await(threeStarted);
      expect(yield* Ref.get(maximum)).toBe(3);
      yield* Deferred.succeed(releaseReads, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }),
  ),
);

it.effect("shares one in-flight probe between callers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseRead = yield* Deferred.make<void>();
      const readStarted = yield* Deferred.make<void>();
      const readCount = yield* Ref.make(0);
      const target = ProviderInstanceId.make("claude_shared");
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Effect.succeed([
          instance({
            id: target,
            read: Ref.update(readCount, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(readStarted, undefined)),
              Effect.andThen(Deferred.await(releaseRead)),
              Effect.as({ used: 1 }),
            ),
          }),
        ]),
        health: usageHealth(),
      });

      const first = yield* coordinator.refresh([target]).pipe(Effect.forkChild);
      yield* Deferred.await(readStarted);
      const second = yield* coordinator.refresh([target]).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(readCount)).toBe(1);
      yield* Deferred.succeed(releaseRead, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }),
  ),
);

it.effect("keeps a shared probe alive when its first caller is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseRead = yield* Deferred.make<void>();
      const readStarted = yield* Deferred.make<void>();
      const readCount = yield* Ref.make(0);
      const target = ProviderInstanceId.make("claude_shared");
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Effect.succeed([
          instance({
            id: target,
            read: Ref.update(readCount, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(readStarted, undefined)),
              Effect.andThen(Deferred.await(releaseRead)),
              Effect.as({ used: 1 }),
            ),
          }),
        ]),
        health: usageHealth(),
      });

      const first = yield* coordinator.refresh([target]).pipe(Effect.forkChild);
      yield* Deferred.await(readStarted);
      const second = yield* coordinator.refresh([target]).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(readCount)).toBe(1);
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(releaseRead, undefined);
      yield* Fiber.join(second);
      expect(yield* Ref.get(readCount)).toBe(1);
    }),
  ),
);

it.effect("does not let a late probe overwrite a newer usage observation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseRead = yield* Deferred.make<void>();
      const readStarted = yield* Deferred.make<void>();
      const target = ProviderInstanceId.make("claude_ordered");
      const health = yield* makeProviderInstanceHealth;
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Effect.succeed([
          instance({
            id: target,
            read: Deferred.succeed(readStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRead)),
              Effect.as({ source: "manual-probe" }),
            ),
          }),
        ]),
        health,
      });

      const probe = yield* coordinator.refresh([target]).pipe(Effect.forkChild);
      yield* Deferred.await(readStarted);
      yield* health.reportUsageSnapshot(
        target,
        { source: "turn-boundary" },
        1_000,
        yield* health.beginUsageObservation(),
        DRIVER_USAGE_SOURCE_KEY,
      );
      yield* Deferred.succeed(releaseRead, undefined);
      const outcome = yield* Fiber.join(probe);

      expect(yield* health.listUsageSnapshots()).toEqual([
        {
          instanceId: target,
          payload: { source: "turn-boundary" },
          observedAt: 1_000,
        },
      ]);
      expect(outcome).toEqual({ refreshedInstanceIds: [], failures: [] });
    }),
  ),
);

it.effect("does not start an adapter that changed while queued behind the probe gate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const blockersStarted = yield* Deferred.make<void>();
      const releaseBlockers = yield* Deferred.make<void>();
      const startedCount = yield* Ref.make(0);
      const staleReads = yield* Ref.make(0);
      const target = ProviderInstanceId.make("claude_queued_stale");
      const blockerCount = 3;
      const blockers = ["one", "two", "three"].map((suffix) =>
        instance({
          id: `claude_blocker_${suffix}`,
          read: Ref.updateAndGet(startedCount, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === blockerCount ? Deferred.succeed(blockersStarted, undefined) : Effect.void,
            ),
            Effect.andThen(Deferred.await(releaseBlockers)),
            Effect.as(undefined),
          ),
        }),
      );
      const stale = instance({
        id: target,
        read: Ref.update(staleReads, (count) => count + 1).pipe(Effect.as({ pool: "stale" })),
      });
      const replacement = instance({ id: target, read: Effect.succeed({ pool: "current" }) });
      const instances = yield* Ref.make<ReadonlyArray<UsageRefreshProviderInstance>>([
        ...blockers,
        stale,
      ]);
      const health = yield* makeProviderInstanceHealth;
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Ref.get(instances),
        health,
      });

      const blockerRefresh = yield* coordinator
        .refresh(blockers.map((blocker) => blocker.instanceId))
        .pipe(Effect.forkChild);
      yield* Deferred.await(blockersStarted);
      const queuedRefresh = yield* coordinator.refresh([target]).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Ref.set(instances, [...blockers, replacement]);
      yield* health.setUsageSource(
        target,
        makeUsageSourceKey(),
        yield* health.beginUsageObservation(),
      );
      yield* Deferred.succeed(releaseBlockers, undefined);

      yield* Fiber.join(blockerRefresh);
      expect(yield* Fiber.join(queuedRefresh)).toEqual({
        refreshedInstanceIds: [],
        failures: [],
      });
      expect(yield* Ref.get(staleReads)).toBe(0);
      expect(yield* health.listUsageSnapshots()).toEqual([]);
    }),
  ),
);

it.effect("starts a new probe when an instance is replaced under the same id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseOldRead = yield* Deferred.make<void>();
      const oldReadStarted = yield* Deferred.make<void>();
      const replacementReads = yield* Ref.make(0);
      const target = ProviderInstanceId.make("claude_replaced");
      const oldInstance = instance({
        id: target,
        read: Deferred.succeed(oldReadStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseOldRead)),
          Effect.as({ source: "old-account" }),
        ),
      });
      const replacementInstance = instance({
        id: target,
        read: Ref.update(replacementReads, (count) => count + 1).pipe(
          Effect.as({ source: "replacement-account" }),
        ),
      });
      const instances = yield* Ref.make<ReadonlyArray<UsageRefreshProviderInstance>>([oldInstance]);
      const health = yield* makeProviderInstanceHealth;
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Ref.get(instances),
        health,
      });

      const oldRefresh = yield* coordinator.refresh([target]).pipe(Effect.forkChild);
      yield* Deferred.await(oldReadStarted);
      yield* Ref.set(instances, [replacementInstance]);
      const replacementRefresh = yield* coordinator.refresh([target]).pipe(Effect.forkChild);

      // A replacement waits for the probe already holding this instance's
      // single-flight slot, then retries against its own adapter. Releasing
      // the old read first keeps the slot tracked throughout the handoff.
      yield* Deferred.succeed(releaseOldRead, undefined);
      yield* Fiber.join(oldRefresh);
      expect(yield* Fiber.join(replacementRefresh)).toEqual({
        refreshedInstanceIds: [target],
        failures: [],
      });

      expect(yield* Ref.get(replacementReads)).toBe(1);
      expect(yield* health.listUsageSnapshots()).toEqual([
        {
          instanceId: target,
          payload: { source: "replacement-account" },
          observedAt: expect.any(Number),
        },
      ]);
    }),
  ),
);

it.effect("keeps a replacement probe tracked when an older refresh registers late", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const oldListEntered = yield* Deferred.make<void>();
      const releaseOldList = yield* Deferred.make<void>();
      const oldListReturned = yield* Deferred.make<void>();
      const currentReadStarted = yield* Deferred.make<void>();
      const releaseCurrentRead = yield* Deferred.make<void>();
      const listCalls = yield* Ref.make(0);
      const oldReads = yield* Ref.make(0);
      const currentReads = yield* Ref.make(0);
      const target = ProviderInstanceId.make("claude_reverse_replacement");
      const oldInstance = instance({
        id: target,
        read: Ref.update(oldReads, (count) => count + 1).pipe(Effect.as({ source: "old-account" })),
      });
      const currentInstance = instance({
        id: target,
        read: Deferred.succeed(currentReadStarted, undefined).pipe(
          Effect.andThen(Ref.update(currentReads, (count) => count + 1)),
          Effect.andThen(Deferred.await(releaseCurrentRead)),
          Effect.as({ source: "current-account" }),
        ),
      });
      const listInstances = Effect.gen(function* () {
        const call = yield* Ref.updateAndGet(listCalls, (count) => count + 1);
        if (call === 1) {
          yield* Deferred.succeed(oldListEntered, undefined);
          yield* Deferred.await(releaseOldList);
          yield* Deferred.succeed(oldListReturned, undefined);
          return [oldInstance];
        }
        return [currentInstance];
      });
      const health = yield* makeProviderInstanceHealth;
      const coordinator = yield* makeProviderUsageRefresh({ listInstances, health });

      // The old caller captures its adapter, but pauses before registering it.
      const oldRefresh = yield* coordinator.refresh([target]).pipe(Effect.forkChild);
      yield* Deferred.await(oldListEntered);

      // The replacement registers first and remains in flight.
      const currentRefresh = yield* coordinator.refresh([target]).pipe(Effect.forkChild);
      yield* Deferred.await(currentReadStarted);
      yield* Deferred.succeed(releaseOldList, undefined);
      yield* Deferred.await(oldListReturned);
      yield* Effect.yieldNow;

      // The late old caller must wait instead of overwriting the replacement's
      // single-flight entry and then deleting its tracking during cleanup.
      expect(oldRefresh.pollUnsafe()).toBeUndefined();
      expect(yield* Ref.get(oldReads)).toBe(0);
      expect(yield* Ref.get(currentReads)).toBe(1);

      yield* Deferred.succeed(releaseCurrentRead, undefined);
      expect(yield* Fiber.join(currentRefresh)).toEqual({
        refreshedInstanceIds: [target],
        failures: [],
      });
      expect(yield* Fiber.join(oldRefresh)).toEqual({ refreshedInstanceIds: [], failures: [] });
      expect(yield* health.listUsageSnapshots()).toEqual([
        {
          instanceId: target,
          payload: { source: "current-account" },
          observedAt: expect.any(Number),
        },
      ]);
    }),
  ),
);

it.effect("reports only the instances that answered on this call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Effect.succeed([
          instance({ id: "claude_ok", read: Effect.succeed({ ok: true }) }),
          // Filtered instances must never appear in the returned array either.
          instance({ id: "claude_disabled", enabled: false, read: Effect.succeed({ x: 1 }) }),
          instance({ id: "claude_unsupported" }),
          // A provider that has nothing to report, and one that fails outright:
          // neither may be counted as refreshed, or the client would suppress
          // its "no new usage data" warning on an all-probes-failed refresh.
          instance({ id: "claude_empty", read: Effect.succeed(undefined) }),
          instance({
            id: "claude_broken",
            read: Effect.die(new Error("probe exploded")),
          }),
        ]),
        health: usageHealth(),
      });

      const outcome = yield* coordinator.refresh();
      expect(outcome.refreshedInstanceIds).toEqual([ProviderInstanceId.make("claude_ok")]);
      // The dead probe carries its reason; the empty one is not a failure.
      expect(outcome.failures).toEqual([
        { instanceId: ProviderInstanceId.make("claude_broken"), reason: "probe exploded" },
      ]);
      expect(
        yield* coordinator.refresh([
          ProviderInstanceId.make("claude_empty"),
          ProviderInstanceId.make("claude_broken"),
        ]),
      ).toMatchObject({ refreshedInstanceIds: [] });
    }),
  ),
);

it.effect("a joined caller receives the shared probe's own outcome", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseRead = yield* Deferred.make<void>();
      const readStarted = yield* Deferred.make<void>();
      const target = ProviderInstanceId.make("claude_shared");
      const coordinator = yield* makeProviderUsageRefresh({
        listInstances: Effect.succeed([
          instance({
            id: target,
            // The joiner never runs a probe of its own, so it must inherit the
            // owner's outcome through the shared Deferred. Reading its own
            // (never-set) Ref would report "not refreshed" and make the client
            // warn about a refresh that actually succeeded.
            read: Deferred.succeed(readStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRead)),
              Effect.as({ used: 1 }),
            ),
          }),
        ]),
        health: usageHealth(),
      });

      const owner = yield* coordinator.refresh([target]).pipe(Effect.forkChild);
      yield* Deferred.await(readStarted);
      const joiner = yield* coordinator.refresh([target]).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseRead, undefined);
      expect((yield* Fiber.join(owner)).refreshedInstanceIds).toEqual([target]);
      expect((yield* Fiber.join(joiner)).refreshedInstanceIds).toEqual([target]);
    }),
  ),
);
