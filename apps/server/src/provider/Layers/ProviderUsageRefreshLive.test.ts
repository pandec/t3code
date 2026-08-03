import { expect, it } from "@effect/vitest";
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

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import {
  ProviderInstanceHealth,
  type UsageObservationToken,
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

function instance(input: {
  readonly id: string;
  readonly enabled?: boolean;
  readonly read?: Effect.Effect<unknown | undefined, ProviderAdapterError>;
  readonly onRead?: () => void;
}): UsageRefreshProviderInstance {
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driverKind: driver,
    enabled: input.enabled ?? true,
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
    Effect.void,
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

        expect(yield* refresh.refresh([target])).toEqual([]);
        expect(yield* Ref.get(gatewayRequests)).toBe(1);
        expect(yield* refresh.refresh([target])).toEqual([]);
        expect(yield* Ref.get(gatewayRequests)).toBe(1);

        // Removing an instance prunes the memoized probe, but the gateway's
        // auth-failure cooldown is tracked per origin, not per closure: a
        // rebuilt instance must not hand the user a fresh set of ban strikes.
        yield* Ref.set(instances, []);
        yield* refresh.refresh();
        yield* Ref.set(instances, [directInstance]);
        expect(yield* refresh.refresh([target])).toEqual([]);
        expect(yield* Ref.get(gatewayRequests)).toBe(1);

        // A declared but unresolved source owns the usage slot and must not
        // silently restore the SDK adapter.
        yield* Ref.update(config, (current) => ({
          ...current,
          usageSource: { kind: "cliproxyapi", managementKey: "" },
        }));
        expect(yield* refresh.refresh([target])).toEqual([]);
        expect(yield* Ref.get(directReads)).toBe(0);
        expect(yield* Ref.get(gatewayRequests)).toBe(1);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("drops the pooled snapshot when the usage source is removed", () =>
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
            ? Ref.get(config)
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
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }))),
        ),
      );
      const layer = ProviderUsageRefreshLive.pipe(
        Layer.provide(registryLayer),
        Layer.provideMerge(healthLayer),
        Layer.provide(httpLayer),
      );

      yield* Effect.gen(function* () {
        yield* ProviderUsageRefresh;
        const health = yield* ProviderInstanceHealth;

        yield* health.reportUsageSnapshot(
          target,
          { pool: "gateway" },
          1_000,
          yield* health.beginUsageObservation(),
        );
        expect(yield* health.listUsageSnapshots()).toHaveLength(1);

        // A probe against the old source is still in flight when the user
        // turns the usage source off.
        const lateToken = yield* health.beginUsageObservation();
        yield* Ref.set(config, { driver, environment, config: {} });
        yield* PubSub.publish(changes, undefined);
        while ((yield* health.listUsageSnapshots()).length > 0) {
          yield* Effect.yieldNow;
        }

        // The late probe must not resurrect the pooled payload…
        yield* health.reportUsageSnapshot(target, { pool: "stale" }, 2_000, lateToken);
        expect(yield* health.listUsageSnapshots()).toEqual([]);

        // …while an observation that begins after the clear reports normally.
        yield* health.reportUsageSnapshot(
          target,
          { source: "direct" },
          3_000,
          yield* health.beginUsageObservation(),
        );
        expect(yield* health.listUsageSnapshots()).toEqual([
          { instanceId: target, payload: { source: "direct" }, observedAt: 3_000 },
        ]);
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
          Ref.update(reports, (current) => [...current, instanceId]),
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
          Ref.update(reports, (current) => [...current, instanceId]),
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
          Ref.update(reports, (current) => [...current, instanceId]),
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
        health: usageHealth(() => Ref.update(reports, (count) => count + 1)),
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
      );
      yield* Deferred.succeed(releaseRead, undefined);
      yield* Fiber.join(probe);

      expect(yield* health.listUsageSnapshots()).toEqual([
        {
          instanceId: target,
          payload: { source: "turn-boundary" },
          observedAt: 1_000,
        },
      ]);
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
      yield* coordinator.refresh([target]);

      expect(yield* Ref.get(replacementReads)).toBe(1);
      expect(yield* health.listUsageSnapshots()).toEqual([
        {
          instanceId: target,
          payload: { source: "replacement-account" },
          observedAt: expect.any(Number),
        },
      ]);

      yield* Deferred.succeed(releaseOldRead, undefined);
      yield* Fiber.join(oldRefresh);
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

      expect(yield* coordinator.refresh()).toEqual([ProviderInstanceId.make("claude_ok")]);
      expect(
        yield* coordinator.refresh([
          ProviderInstanceId.make("claude_empty"),
          ProviderInstanceId.make("claude_broken"),
        ]),
      ).toEqual([]);
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
      expect(yield* Fiber.join(owner)).toEqual([target]);
      expect(yield* Fiber.join(joiner)).toEqual([target]);
    }),
  ),
);
