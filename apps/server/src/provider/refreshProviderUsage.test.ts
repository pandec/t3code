import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import type { ProviderAdapterError } from "./Errors.ts";
import {
  refreshProviderUsageSnapshots,
  type UsageRefreshProviderInstance,
} from "./refreshProviderUsage.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const now = "2026-01-01T00:00:00.000Z";

function liveSession(instanceId: ProviderInstanceId): ProviderSession {
  return {
    provider: driver,
    providerInstanceId: instanceId,
    status: "ready",
    runtimeMode: "full-access",
    threadId: ThreadId.make(`thread-${instanceId}`),
    createdAt: now,
    updatedAt: now,
  };
}

function instance(input: {
  readonly id: string;
  readonly enabled?: boolean;
  readonly sessions?: ReadonlyArray<ProviderSession>;
  readonly read?: Effect.Effect<unknown | undefined, ProviderAdapterError>;
  readonly onRead?: () => void;
}): UsageRefreshProviderInstance {
  const instanceId = ProviderInstanceId.make(input.id);
  return {
    instanceId,
    driverKind: driver,
    enabled: input.enabled ?? true,
    adapter: {
      listSessions: () => Effect.succeed(input.sessions ?? []),
      ...(input.read !== undefined || input.onRead !== undefined
        ? {
            readAccountUsage: () =>
              Effect.sync(() => input.onRead?.()).pipe(
                Effect.andThen(input.read ?? Effect.succeed({ id: input.id })),
              ),
          }
        : {}),
    },
  };
}

it.effect("skips disabled, unsupported, and live-session instances", () =>
  Effect.gen(function* () {
    const reads: string[] = [];
    const liveId = ProviderInstanceId.make("claude_live");
    const instances = [
      instance({ id: "claude_disabled", enabled: false, onRead: () => reads.push("disabled") }),
      instance({ id: "claude_unsupported" }),
      instance({
        id: liveId,
        sessions: [liveSession(liveId)],
        onRead: () => reads.push("live"),
      }),
      instance({ id: "claude_idle", onRead: () => reads.push("idle") }),
    ];
    const reports = yield* Ref.make<ReadonlyArray<string>>([]);

    yield* refreshProviderUsageSnapshots(
      {
        listInstances: Effect.succeed(instances),
        health: {
          reportUsageSnapshot: (instanceId) =>
            Ref.update(reports, (current) => [...current, instanceId]),
        },
      },
      undefined,
    );

    expect(reads).toEqual(["idle"]);
    expect(yield* Ref.get(reports)).toEqual(["claude_idle"]);
  }),
);

it.effect("isolates one instance failure and continues refreshing siblings", () =>
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

    yield* refreshProviderUsageSnapshots({
      listInstances: Effect.succeed(instances),
      health: {
        reportUsageSnapshot: (instanceId) =>
          Ref.update(reports, (current) => [...current, instanceId]),
      },
    });

    expect(yield* Ref.get(reports)).toEqual(["claude_healthy"]);
  }),
);

it.effect("honors an explicit instance-id subset", () =>
  Effect.gen(function* () {
    const reads: string[] = [];
    const target = ProviderInstanceId.make("claude_target");
    yield* refreshProviderUsageSnapshots(
      {
        listInstances: Effect.succeed([
          instance({ id: target, onRead: () => reads.push("target") }),
          instance({ id: "claude_other", onRead: () => reads.push("other") }),
        ]),
        health: { reportUsageSnapshot: () => Effect.void },
      },
      [target],
    );
    expect(reads).toEqual(["target"]);
  }),
);

it.effect("caps concurrent provider reads at three", () =>
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
    const refreshFiber = yield* Effect.forkChild(
      refreshProviderUsageSnapshots({
        listInstances: Effect.succeed(
          Array.from({ length: 5 }, (_, index) => instance({ id: `claude_${index}`, read })),
        ),
        health: { reportUsageSnapshot: () => Effect.void },
      }),
    );

    yield* Deferred.await(threeStarted);
    expect(yield* Ref.get(maximum)).toBe(3);
    yield* Deferred.succeed(releaseReads, undefined);
    yield* Fiber.join(refreshFiber);
  }),
);
