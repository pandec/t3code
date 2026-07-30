import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  ProviderInstanceHealth,
  type ProviderInstanceHealthShape,
  type ProviderInstanceRateLimitState,
  type ProviderInstanceUsageSnapshot,
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
  /rate.?limit|usage limit|(?:quota|credits?) (?:limit )?reached|out of (?:usage|quota|credits)|\b429\b/i;
const TOOL_RATE_LIMIT_ERROR_PATTERN =
  /^(?:tool\b.*(?:failed|error)|error (?:executing|calling) (?:the )?tool\b|mcp\b|upstream api\b)/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Normalize a reset timestamp that may be unix seconds or unix ms. */
function normalizeResetsAt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

type RateLimitVerdict =
  | {
      readonly kind: "limited";
      readonly until: number | null;
      readonly reason: string;
      readonly windowType?: string;
    }
  | { readonly kind: "clear"; readonly windowType?: string }
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
  const windowType = typeof info.rateLimitType === "string" ? info.rateLimitType : undefined;
  if (status === "rejected") {
    const until = normalizeResetsAt(info.resetsAt);
    return {
      kind: "limited",
      until,
      reason: windowType ? `usage limit reached (${windowType})` : "usage limit reached",
      ...(windowType ? { windowType } : {}),
    };
  }
  if (status === "allowed" || status === "allowed_warning") {
    return { kind: "clear", ...(windowType ? { windowType } : {}) };
  }
  return { kind: "unknown" };
}

/** Whether a turn-failure message classifies as an account rate limit. */
export function isRateLimitErrorMessage(errorMessage: string | undefined): boolean {
  return (
    errorMessage !== undefined &&
    !TOOL_RATE_LIMIT_ERROR_PATTERN.test(errorMessage) &&
    RATE_LIMIT_ERROR_PATTERN.test(errorMessage)
  );
}

const makeProviderInstanceHealth = Effect.gen(function* () {
  const states = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, ReadonlyMap<string, ProviderInstanceRateLimitState>>
  >(new Map());
  const usageSnapshots = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, ProviderInstanceUsageSnapshot>
  >(new Map());

  const windowStateKey = (windowType: string | undefined) =>
    `provider-window:${windowType ?? "unknown"}`;
  const expiresAt = (state: ProviderInstanceRateLimitState) =>
    state.until ?? state.reportedAt + UNKNOWN_RESET_LIMIT_TTL_MS;

  const clearAllStates = (instanceId: ProviderInstanceId) =>
    Ref.update(states, (map) => {
      if (!map.has(instanceId)) return map;
      const next = new Map(map);
      next.delete(instanceId);
      return next;
    });

  const clearState = (instanceId: ProviderInstanceId, key: string) =>
    Ref.update(states, (map) => {
      const current = map.get(instanceId);
      if (!current?.has(key)) return map;
      const instanceStates = new Map(current);
      instanceStates.delete(key);
      const next = new Map(map);
      if (instanceStates.size === 0) {
        next.delete(instanceId);
      } else {
        next.set(instanceId, instanceStates);
      }
      return next;
    });

  const reportRateLimitPayload: ProviderInstanceHealthShape["reportRateLimitPayload"] = Effect.fn(
    "ProviderInstanceHealth.reportRateLimitPayload",
  )(function* (instanceId, payload) {
    const verdict = classifyRateLimitPayload(payload);
    if (verdict.kind === "limited") {
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(states, (map) => {
        const instanceStates = new Map(map.get(instanceId) ?? []);
        instanceStates.delete("turn-failure");
        instanceStates.set(windowStateKey(verdict.windowType), {
          until: verdict.until,
          reason: verdict.reason,
          reportedAt: now,
        });
        return new Map(map).set(instanceId, instanceStates);
      });
      yield* Effect.logInfo("Provider instance marked rate-limited.", {
        instanceId,
        until: verdict.until,
        reason: verdict.reason,
      });
      return;
    }
    if (verdict.kind === "clear") {
      if (verdict.windowType === undefined) {
        yield* clearAllStates(instanceId);
      } else {
        yield* Ref.update(states, (map) => {
          const current = map.get(instanceId);
          if (current === undefined) return map;
          const instanceStates = new Map(current);
          instanceStates.delete("turn-failure");
          instanceStates.delete(windowStateKey(verdict.windowType));
          const next = new Map(map);
          if (instanceStates.size === 0) {
            next.delete(instanceId);
          } else {
            next.set(instanceId, instanceStates);
          }
          return next;
        });
      }
    }
  });

  const reportUsageSnapshot: ProviderInstanceHealthShape["reportUsageSnapshot"] = Effect.fn(
    "ProviderInstanceHealth.reportUsageSnapshot",
  )(function* (instanceId, payload, observedAt) {
    yield* Ref.update(usageSnapshots, (snapshots) => {
      const current = snapshots.get(instanceId);
      if (current !== undefined && current.observedAt > observedAt) {
        return snapshots;
      }
      return new Map(snapshots).set(instanceId, {
        instanceId,
        payload,
        observedAt,
      });
    });
  });

  const listUsageSnapshots: ProviderInstanceHealthShape["listUsageSnapshots"] = () =>
    Ref.get(usageSnapshots).pipe(Effect.map((snapshots) => Array.from(snapshots.values())));

  const reportTurnOutcome: ProviderInstanceHealthShape["reportTurnOutcome"] = Effect.fn(
    "ProviderInstanceHealth.reportTurnOutcome",
  )(function* (instanceId, outcome, errorMessage) {
    if (outcome === "success") {
      yield* clearState(instanceId, "turn-failure");
      return;
    }
    if (!isRateLimitErrorMessage(errorMessage)) {
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(states, (map) => {
      const current = map.get(instanceId);
      const activeStates = new Map(
        [...(current ?? [])].filter(([, state]) => {
          return now < expiresAt(state);
        }),
      );
      // A provider-window rejection carries more precise reset information
      // than the unstructured turn failure, so keep it as the routing signal.
      if ([...activeStates.keys()].some((key) => key.startsWith("provider-window:"))) {
        activeStates.delete("turn-failure");
        return activeStates.size === current?.size
          ? map
          : new Map(map).set(instanceId, activeStates);
      }
      activeStates.set("turn-failure", {
        until: null,
        reason: errorMessage ?? "turn failed with a rate limit error",
        reportedAt: now,
      });
      return new Map(map).set(instanceId, activeStates);
    });
    yield* Effect.logInfo("Provider instance marked rate-limited by turn failure.", {
      instanceId,
      reason: errorMessage,
    });
  });

  const getRateLimitState: ProviderInstanceHealthShape["getRateLimitState"] = Effect.fn(
    "ProviderInstanceHealth.getRateLimitState",
  )(function* (instanceId) {
    const now = yield* Clock.currentTimeMillis;
    return yield* Ref.modify(states, (map) => {
      const current = map.get(instanceId);
      if (current === undefined) return [undefined, map];
      const activeStates = new Map(
        [...current].filter(([, state]) => {
          return now < expiresAt(state);
        }),
      );
      if (activeStates.size === 0) {
        const next = new Map(map);
        next.delete(instanceId);
        return [undefined, next];
      }
      const state = [...activeStates.values()].reduce((latest, candidate) =>
        expiresAt(candidate) > expiresAt(latest) ? candidate : latest,
      );
      return [
        state,
        activeStates.size === current.size ? map : new Map(map).set(instanceId, activeStates),
      ];
    });
  });

  return {
    reportRateLimitPayload,
    reportUsageSnapshot,
    listUsageSnapshots,
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
