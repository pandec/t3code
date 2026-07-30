import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import type { ProviderAdapterError } from "../Errors.ts";
import {
  makeProviderUsageRefresh,
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
        health: {
          reportUsageSnapshot: (instanceId) =>
            Ref.update(reports, (current) => [...current, instanceId]),
        },
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
        health: {
          reportUsageSnapshot: (instanceId) =>
            Ref.update(reports, (current) => [...current, instanceId]),
        },
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
        health: {
          reportUsageSnapshot: (instanceId) =>
            Ref.update(reports, (current) => [...current, instanceId]),
        },
      });

      yield* coordinator.refresh();

      expect(yield* Ref.get(reports)).toEqual(["claude_healthy"]);
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
        health: { reportUsageSnapshot: () => Effect.void },
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
        health: { reportUsageSnapshot: () => Effect.void },
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
        health: { reportUsageSnapshot: () => Effect.void },
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
        health: { reportUsageSnapshot: () => Effect.void },
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
