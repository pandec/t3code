import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";

import { DRIVER_USAGE_SOURCE_KEY, makeUsageSourceKey } from "../Services/ProviderInstanceHealth.ts";
import {
  classifyRateLimitPayload,
  isRateLimitErrorMessage,
  makeProviderInstanceHealth,
  UNKNOWN_RESET_LIMIT_TTL_MS,
} from "./ProviderInstanceHealthLive.ts";

const instanceId = ProviderInstanceId.make("claude_main");
// `it.effect` runs under the TestClock, which starts at epoch 0 — one hour
// from "now" is simply 3600 (unix seconds).
const RESETS_AT_SECONDS = 3_600;

describe("classifyRateLimitPayload", () => {
  it("marks rejected rate_limit_info as limited with a normalized reset time", () => {
    const verdict = classifyRateLimitPayload({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: RESETS_AT_SECONDS,
      },
    });
    expect(verdict).toEqual({
      kind: "limited",
      until: RESETS_AT_SECONDS * 1_000,
      reason: "usage limit reached (five_hour)",
      windowType: "five_hour",
    });
  });

  it("clears on allowed and allowed_warning", () => {
    for (const status of ["allowed", "allowed_warning"]) {
      expect(classifyRateLimitPayload({ rate_limit_info: { status } })).toEqual({ kind: "clear" });
    }
  });

  it("ignores usage-percentage payloads and malformed input", () => {
    expect(
      classifyRateLimitPayload({
        source: "claude.usage-api",
        rateLimits: { five_hour: { utilization: 100 } },
      }),
    ).toEqual({ kind: "unknown" });
    expect(classifyRateLimitPayload(null)).toEqual({ kind: "unknown" });
    expect(classifyRateLimitPayload("rejected")).toEqual({ kind: "unknown" });
  });
});

describe("isRateLimitErrorMessage", () => {
  it("classifies account-limit failures", () => {
    expect(isRateLimitErrorMessage("You have hit your usage limit for Claude")).toBe(true);
    expect(isRateLimitErrorMessage("API error 429: rate_limit_error")).toBe(true);
    expect(isRateLimitErrorMessage(undefined)).toBe(false);
    expect(isRateLimitErrorMessage("Tool execution failed: file not found")).toBe(false);
    expect(isRateLimitErrorMessage("Tool execution failed: output size limit reached")).toBe(false);
    expect(isRateLimitErrorMessage("Tool execution failed: upstream API rate limit reached")).toBe(
      false,
    );
    expect(isRateLimitErrorMessage("MCP server returned API error 429: rate_limit_error")).toBe(
      false,
    );
    expect(isRateLimitErrorMessage("Recursion limit reached while evaluating tool output")).toBe(
      false,
    );
  });
});

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
        DRIVER_USAGE_SOURCE_KEY,
      );
      yield* health.reportUsageSnapshot(
        instanceId,
        replacementPayload,
        2_000,
        yield* health.beginUsageObservation(),
        DRIVER_USAGE_SOURCE_KEY,
      );
      yield* health.reportUsageSnapshot(
        secondInstanceId,
        { secondary: { usedPercent: 7 } },
        2_000,
        yield* health.beginUsageObservation(),
        DRIVER_USAGE_SOURCE_KEY,
      );

      expect(yield* health.listUsageSnapshots()).toEqual([
        { instanceId, payload: replacementPayload, observedAt: 2_000 },
        {
          instanceId: secondInstanceId,
          payload: { secondary: { usedPercent: 7 } },
          observedAt: 2_000,
        },
      ]);
      expect(yield* health.getRateLimitState(instanceId)).toBeUndefined();
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

      yield* health.reportUsageSnapshot(
        instanceId,
        newerPayload,
        1_000,
        secondToken,
        DRIVER_USAGE_SOURCE_KEY,
      );
      yield* health.reportUsageSnapshot(
        instanceId,
        olderPayload,
        3_000,
        firstToken,
        DRIVER_USAGE_SOURCE_KEY,
      );
      expect(yield* health.listUsageSnapshots()).toEqual([
        { instanceId, payload: newerPayload, observedAt: 1_000 },
      ]);

      const thirdToken = yield* health.beginUsageObservation();
      yield* health.reportUsageSnapshot(
        instanceId,
        equalTimestampPayload,
        1_000,
        thirdToken,
        DRIVER_USAGE_SOURCE_KEY,
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
        DRIVER_USAGE_SOURCE_KEY,
      );
      yield* health.reportUsageSnapshot(
        instanceId,
        replayPayload,
        4_000,
        fourthToken,
        DRIVER_USAGE_SOURCE_KEY,
      );
      expect(yield* health.listUsageSnapshots()).toEqual([
        { instanceId, payload: backwardClockPayload, observedAt: 500 },
      ]);
    }),
  );

  it.effect("gates usage writes by the active source while preserving whole-payload LWW", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;
      const gatewaySource = makeUsageSourceKey();
      const directToken = yield* health.beginUsageObservation();
      expect(
        yield* health.reportUsageSnapshot(
          instanceId,
          { source: "direct" },
          1_000,
          directToken,
          DRIVER_USAGE_SOURCE_KEY,
        ),
      ).toBe(true);

      const gatewayDeclaration = yield* health.beginUsageObservation();
      yield* health.setUsageSource(instanceId, gatewaySource, gatewayDeclaration);
      expect(yield* health.listUsageSnapshots()).toEqual([]);

      // A stale source declaration and a newer wrong-source payload both lose
      // atomically to the gateway declaration.
      yield* health.setUsageSource(instanceId, DRIVER_USAGE_SOURCE_KEY, directToken);
      expect(
        yield* health.reportUsageSnapshot(
          instanceId,
          { source: "stale-direct" },
          2_000,
          yield* health.beginUsageObservation(),
          DRIVER_USAGE_SOURCE_KEY,
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

  it.effect("marks, reads, and clears rate-limit state", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;

      expect(yield* health.getRateLimitState(instanceId)).toBeUndefined();

      yield* health.reportRateLimitPayload(instanceId, {
        rate_limit_info: { status: "rejected", resetsAt: RESETS_AT_SECONDS },
      });
      expect(yield* health.getRateLimitState(instanceId)).toBeDefined();

      yield* health.reportRateLimitPayload(instanceId, {
        rate_limit_info: { status: "allowed" },
      });
      expect(yield* health.getRateLimitState(instanceId)).toBeUndefined();
    }),
  );

  it.effect("clears only the matching provider window", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;

      yield* health.reportRateLimitPayload(instanceId, {
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: RESETS_AT_SECONDS,
        },
      });
      yield* health.reportRateLimitPayload(instanceId, {
        rate_limit_info: { status: "allowed", rateLimitType: "seven_day" },
      });
      expect(yield* health.getRateLimitState(instanceId)).toBeDefined();

      yield* health.reportRateLimitPayload(instanceId, {
        rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
      });
      expect(yield* health.getRateLimitState(instanceId)).toBeUndefined();
    }),
  );

  it.effect("expires a limit at its reset time", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;

      yield* health.reportRateLimitPayload(instanceId, {
        rate_limit_info: { status: "rejected", resetsAt: RESETS_AT_SECONDS },
      });
      expect(yield* health.getRateLimitState(instanceId)).toBeDefined();

      yield* TestClock.adjust(Duration.seconds(RESETS_AT_SECONDS + 1));
      expect(yield* health.getRateLimitState(instanceId)).toBeUndefined();
    }),
  );

  it.effect("expires a reset-less limit after the bounded TTL", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;

      yield* health.reportTurnOutcome(instanceId, "failed", "rate limit reached");
      expect(yield* health.getRateLimitState(instanceId)).toBeDefined();

      yield* TestClock.adjust(Duration.millis(UNKNOWN_RESET_LIMIT_TTL_MS + 1));
      expect(yield* health.getRateLimitState(instanceId)).toBeUndefined();
    }),
  );

  it.effect("marks on a rate-limit turn failure and clears on turn success", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;

      yield* health.reportTurnOutcome(instanceId, "failed", "Claude usage limit reached");
      const limited = yield* health.getRateLimitState(instanceId);
      expect(limited).toBeDefined();
      // No provider reset time: the bounded TTL applies instead.
      expect(limited?.until).toBeNull();

      yield* health.reportTurnOutcome(instanceId, "success");
      expect(yield* health.getRateLimitState(instanceId)).toBeUndefined();
    }),
  );

  it.effect("does not let generic success clear a structured provider rejection", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;

      yield* health.reportRateLimitPayload(instanceId, {
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: RESETS_AT_SECONDS,
        },
      });
      yield* health.reportTurnOutcome(instanceId, "success");

      expect((yield* health.getRateLimitState(instanceId))?.until).toBe(RESETS_AT_SECONDS * 1_000);
    }),
  );

  it.effect("lets structured window evidence supersede a fallback turn failure", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;

      yield* health.reportTurnOutcome(instanceId, "failed", "rate limit reached");
      yield* health.reportRateLimitPayload(instanceId, {
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: RESETS_AT_SECONDS,
        },
      });
      yield* health.reportRateLimitPayload(instanceId, {
        rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
      });

      expect(yield* health.getRateLimitState(instanceId)).toBeUndefined();
    }),
  );

  it.effect("ignores turn failures that do not classify as rate limits", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;

      yield* health.reportTurnOutcome(instanceId, "failed", "Model refused the request");
      expect(yield* health.getRateLimitState(instanceId)).toBeUndefined();
    }),
  );

  it.effect("keeps a known future reset time when a turn failure follows", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;

      yield* health.reportRateLimitPayload(instanceId, {
        rate_limit_info: { status: "rejected", resetsAt: RESETS_AT_SECONDS },
      });
      yield* health.reportTurnOutcome(instanceId, "failed", "rate limit reached");

      expect((yield* health.getRateLimitState(instanceId))?.until).toBe(RESETS_AT_SECONDS * 1_000);
    }),
  );

  it.effect("reports the longest-lived active provider window", () =>
    Effect.gen(function* () {
      const health = yield* makeProviderInstanceHealth;

      yield* health.reportRateLimitPayload(instanceId, {
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: RESETS_AT_SECONDS,
        },
      });
      yield* health.reportRateLimitPayload(instanceId, {
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "seven_day",
          resetsAt: RESETS_AT_SECONDS * 2,
        },
      });

      expect(yield* health.getRateLimitState(instanceId)).toMatchObject({
        until: RESETS_AT_SECONDS * 2 * 1_000,
        reason: "usage limit reached (seven_day)",
      });
    }),
  );
});
