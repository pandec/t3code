import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  ProviderInstanceHealth,
  type ProviderInstanceHealthShape,
  type ProviderInstanceRateLimitState,
} from "../Services/ProviderInstanceHealth.ts";

/**
 * How long a limit without a provider-supplied reset time is honored before
 * the instance is considered routable again. Deliberately short: a false
 * "limited" verdict silently reroutes turns, while a false "healthy" verdict
 * merely costs one failed turn that re-marks the instance.
 */
export const UNKNOWN_RESET_LIMIT_TTL_MS = 15 * 60 * 1_000;

/**
 * Turn-failure messages that indicate an account usage limit rather than a
 * turn-specific problem. Matched against provider error text, which is
 * unversioned prose — keep the patterns narrow enough not to catch tool
 * failures that merely mention limits.
 */
const RATE_LIMIT_ERROR_PATTERN =
  /rate.?limit|usage limit|limit reached|out of (?:usage|quota|credits)|\b429\b/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Normalize a reset timestamp that may be unix seconds or unix ms. */
function normalizeResetsAt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

type RateLimitVerdict =
  | { readonly kind: "limited"; readonly until: number | null; readonly reason: string }
  | { readonly kind: "clear" }
  | { readonly kind: "unknown" };

/**
 * Extract an allow/reject verdict from a raw rate-limit payload. Understands
 * the Claude SDK's `rate_limit_event` message (`rate_limit_info.status`);
 * usage-percentage payloads (Claude `/usage`, Codex windows) yield "unknown"
 * because utilization alone is not a rejection.
 */
export function classifyRateLimitPayload(payload: unknown): RateLimitVerdict {
  const record = asRecord(payload);
  if (!record) return { kind: "unknown" };
  const info = asRecord(record.rate_limit_info);
  if (!info) return { kind: "unknown" };
  const status = info.status;
  if (status === "rejected") {
    const until = normalizeResetsAt(info.resetsAt);
    const windowType = typeof info.rateLimitType === "string" ? info.rateLimitType : undefined;
    return {
      kind: "limited",
      until,
      reason: windowType ? `usage limit reached (${windowType})` : "usage limit reached",
    };
  }
  if (status === "allowed" || status === "allowed_warning") {
    return { kind: "clear" };
  }
  return { kind: "unknown" };
}

/** Whether a turn-failure message classifies as an account rate limit. */
export function isRateLimitErrorMessage(errorMessage: string | undefined): boolean {
  return errorMessage !== undefined && RATE_LIMIT_ERROR_PATTERN.test(errorMessage);
}

const makeProviderInstanceHealth = Effect.gen(function* () {
  const states = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ProviderInstanceRateLimitState>>(
    new Map(),
  );

  const setState = (instanceId: ProviderInstanceId, state: ProviderInstanceRateLimitState) =>
    Ref.update(states, (map) => new Map(map).set(instanceId, state));

  const clearState = (instanceId: ProviderInstanceId) =>
    Ref.update(states, (map) => {
      if (!map.has(instanceId)) return map;
      const next = new Map(map);
      next.delete(instanceId);
      return next;
    });

  const reportRateLimitPayload: ProviderInstanceHealthShape["reportRateLimitPayload"] = Effect.fn(
    "ProviderInstanceHealth.reportRateLimitPayload",
  )(function* (instanceId, payload) {
    const verdict = classifyRateLimitPayload(payload);
    if (verdict.kind === "limited") {
      const now = yield* Clock.currentTimeMillis;
      yield* setState(instanceId, {
        until: verdict.until,
        reason: verdict.reason,
        reportedAt: now,
      });
      yield* Effect.logInfo("Provider instance marked rate-limited.", {
        instanceId,
        until: verdict.until,
        reason: verdict.reason,
      });
      return;
    }
    if (verdict.kind === "clear") {
      yield* clearState(instanceId);
    }
  });

  const reportTurnOutcome: ProviderInstanceHealthShape["reportTurnOutcome"] = Effect.fn(
    "ProviderInstanceHealth.reportTurnOutcome",
  )(function* (instanceId, outcome, errorMessage) {
    if (outcome === "success") {
      yield* clearState(instanceId);
      return;
    }
    if (!isRateLimitErrorMessage(errorMessage)) {
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    const existing = (yield* Ref.get(states)).get(instanceId);
    yield* setState(instanceId, {
      // A previously reported reset time is better information than a
      // failure message without one; keep it when it is still ahead.
      until:
        existing?.until !== undefined && existing.until !== null && existing.until > now
          ? existing.until
          : null,
      reason: errorMessage ?? "turn failed with a rate limit error",
      reportedAt: now,
    });
    yield* Effect.logInfo("Provider instance marked rate-limited by turn failure.", {
      instanceId,
      reason: errorMessage,
    });
  });

  const getRateLimitState: ProviderInstanceHealthShape["getRateLimitState"] = Effect.fn(
    "ProviderInstanceHealth.getRateLimitState",
  )(function* (instanceId) {
    const state = (yield* Ref.get(states)).get(instanceId);
    if (state === undefined) return undefined;
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = state.until ?? state.reportedAt + UNKNOWN_RESET_LIMIT_TTL_MS;
    if (now >= expiresAt) {
      yield* clearState(instanceId);
      return undefined;
    }
    return state;
  });

  return {
    reportRateLimitPayload,
    reportTurnOutcome,
    getRateLimitState,
  } satisfies ProviderInstanceHealthShape;
});

export const ProviderInstanceHealthLive = Layer.effect(
  ProviderInstanceHealth,
  makeProviderInstanceHealth,
);

// Exposed for tests that assemble the service without the layer graph.
export { makeProviderInstanceHealth };
