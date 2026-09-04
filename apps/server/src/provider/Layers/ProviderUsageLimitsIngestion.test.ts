import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderRuntimeEvent,
  type ProviderUsageLimitsUpdate,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderUsageLimitsIngestionLive } from "./ProviderUsageLimitsIngestion.ts";

const directId = ProviderInstanceId.make("codex");
const gatewayId = ProviderInstanceId.make("codex_proxy");

const rateLimitEvent = (
  providerInstanceId: ProviderInstanceId,
  payload: ProviderRuntimeEvent extends { payload: infer P } ? P : never,
): ProviderRuntimeEvent =>
  ({
    type: "account.rate-limits.updated",
    eventId: `evt-${providerInstanceId}`,
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId,
    createdAt: "2026-01-01T00:00:00.000Z",
    threadId: "thread-1",
    payload,
  }) as unknown as ProviderRuntimeEvent;

describe("ProviderUsageLimitsIngestionLive", () => {
  it.effect("applies typed limits to driver-owned instances only", () =>
    Effect.gen(function* () {
      const applied = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
      const makeInstance = (instanceId: ProviderInstanceId) =>
        ({
          instanceId,
          snapshot: {
            applyUsageLimits: (_update: ProviderUsageLimitsUpdate) =>
              Ref.update(applied, (ids) => [...ids, instanceId]),
          },
        }) as unknown as ProviderInstance;
      const gatewayConfig = {
        usageSource: { kind: "cliproxyapi", url: "http://gateway:8318" },
      } as unknown as ProviderInstanceConfig;
      const events = [
        rateLimitEvent(directId, { limits: { windows: [] } }),
        // A gateway pool owns this instance's usage slot.
        rateLimitEvent(gatewayId, { limits: { windows: [] } }),
        // Raw-only: typed normalisation failed, nothing for this layer.
        rateLimitEvent(directId, { rateLimits: { limitId: "codex" } }),
      ];
      const layer = ProviderUsageLimitsIngestionLive.pipe(
        Layer.provide(
          Layer.succeed(ProviderInstanceRegistry, {
            getInstance: (instanceId) => Effect.succeed(makeInstance(instanceId)),
            getInstanceConfig: (instanceId) =>
              Effect.succeed(instanceId === gatewayId ? gatewayConfig : undefined),
            listInstances: Effect.succeed([]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          }),
        ),
        Layer.provide(
          Layer.succeed(ProviderService, {
            streamEvents: Stream.fromIterable(events),
          } as unknown as ProviderService["Service"]),
        ),
      );

      yield* Layer.build(layer).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(Effect.yieldNow),
        Effect.scoped,
      );

      expect(yield* Ref.get(applied)).toEqual([directId]);
    }),
  );
});
