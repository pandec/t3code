import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeProviderInstanceHealth } from "./ProviderInstanceHealthLive.ts";

const instanceId = ProviderInstanceId.make("claude_main");

describe("ProviderInstanceHealth", () => {
  it.effect("stores the latest opaque usage snapshot independently per instance", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;
      const secondInstanceId = ProviderInstanceId.make("claude_second");
      const firstPayload = { source: "claude.usage-api", rateLimits: { limits: [] } };
      const replacementPayload = { primary: { usedPercent: 42 } };

      yield* health.reportUsageSnapshot(
        instanceId,
        firstPayload,
        0,
        yield* health.beginUsageObservation(),
        "driver",
      );
      yield* health.reportUsageSnapshot(
        instanceId,
        replacementPayload,
        2_000,
        yield* health.beginUsageObservation(),
        "driver",
      );
      yield* health.reportUsageSnapshot(
        secondInstanceId,
        { secondary: { usedPercent: 7 } },
        2_000,
        yield* health.beginUsageObservation(),
        "driver",
      );

      expect(yield* health.listUsageSnapshots()).toEqual([
        { instanceId, payload: replacementPayload, observedAt: 2_000 },
        {
          instanceId: secondInstanceId,
          payload: { secondary: { usedPercent: 7 } },
          observedAt: 2_000,
        },
      ]);
    }),
  );

  it.effect("orders usage writes by monotonic observation token instead of wall time", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;
      const newerPayload = { source: "newer" };
      const olderPayload = { source: "older" };
      const equalTimestampPayload = { source: "equal-timestamp" };
      const backwardClockPayload = { source: "backward-clock" };
      const replayPayload = { source: "replayed-token" };
      const firstToken = yield* health.beginUsageObservation();
      const secondToken = yield* health.beginUsageObservation();

      expect(secondToken).toBeGreaterThan(firstToken);

      yield* health.reportUsageSnapshot(instanceId, newerPayload, 1_000, secondToken, "driver");
      yield* health.reportUsageSnapshot(instanceId, olderPayload, 3_000, firstToken, "driver");
      expect(yield* health.listUsageSnapshots()).toEqual([
        { instanceId, payload: newerPayload, observedAt: 1_000 },
      ]);

      const thirdToken = yield* health.beginUsageObservation();
      yield* health.reportUsageSnapshot(
        instanceId,
        equalTimestampPayload,
        1_000,
        thirdToken,
        "driver",
      );
      expect(yield* health.listUsageSnapshots()).toEqual([
        { instanceId, payload: equalTimestampPayload, observedAt: 1_000 },
      ]);

      const fourthToken = yield* health.beginUsageObservation();
      yield* health.reportUsageSnapshot(
        instanceId,
        backwardClockPayload,
        500,
        fourthToken,
        "driver",
      );
      yield* health.reportUsageSnapshot(instanceId, replayPayload, 4_000, fourthToken, "driver");
      expect(yield* health.listUsageSnapshots()).toEqual([
        { instanceId, payload: backwardClockPayload, observedAt: 500 },
      ]);
    }),
  );

  it.effect("gates usage writes by the active source while preserving whole-payload LWW", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;
      const gatewaySource = "gateway" as const;
      const directToken = yield* health.beginUsageObservation();
      expect(
        yield* health.reportUsageSnapshot(
          instanceId,
          { source: "direct" },
          1_000,
          directToken,
          "driver",
        ),
      ).toBe(true);

      const gatewayDeclaration = yield* health.beginUsageObservation();
      yield* health.setUsageSource(instanceId, gatewaySource, gatewayDeclaration);
      expect(yield* health.listUsageSnapshots()).toEqual([]);

      // A stale source declaration and a newer wrong-source payload both lose
      // atomically to the gateway declaration.
      yield* health.setUsageSource(instanceId, "driver", directToken);
      expect(
        yield* health.reportUsageSnapshot(
          instanceId,
          { source: "stale-direct" },
          2_000,
          yield* health.beginUsageObservation(),
          "driver",
        ),
      ).toBe(false);

      const gatewayToken = yield* health.beginUsageObservation();
      expect(
        yield* health.reportUsageSnapshot(
          instanceId,
          { source: "gateway" },
          3_000,
          gatewayToken,
          gatewaySource,
        ),
      ).toBe(true);
      // Re-declaring the same source after its report must preserve it.
      yield* health.setUsageSource(
        instanceId,
        gatewaySource,
        yield* health.beginUsageObservation(),
      );
      expect(yield* health.listUsageSnapshots()).toEqual([
        { instanceId, payload: { source: "gateway" }, observedAt: 3_000 },
      ]);
    }),
  );
});
