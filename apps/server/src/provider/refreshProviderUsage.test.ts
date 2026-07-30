import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ProviderAdapterError } from "./Errors.ts";
import {
  refreshProviderUsageSnapshots,
  type UsageRefreshProviderInstance,
} from "./refreshProviderUsage.ts";

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
  Effect.gen(function* () {
    const reads: string[] = [];
    const instances = [
      instance({ id: "claude_disabled", enabled: false, onRead: () => reads.push("disabled") }),
      instance({ id: "claude_unsupported" }),
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

it.effect("skips reporting when the adapter has no usage payload", () =>
  Effect.gen(function* () {
    const reports = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* refreshProviderUsageSnapshots({
      listInstances: Effect.succeed([instance({ id: "claude_empty", read: Effect.void })]),
      health: {
        reportUsageSnapshot: (instanceId) =>
          Ref.update(reports, (current) => [...current, instanceId]),
      },
    });
    expect(yield* Ref.get(reports)).toEqual([]);
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
