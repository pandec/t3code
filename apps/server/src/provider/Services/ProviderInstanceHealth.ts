/**
 * ProviderInstanceHealth — per-instance rate-limit state for failover routing.
 *
 * Fed by `ProviderRuntimeIngestion` from the provider runtime event stream;
 * read by `ProviderCommandReactor` at turn start to decide whether a turn
 * should be routed to an instance's configured `failoverInstanceId` sibling.
 *
 * The state is deliberately in-memory only: a rate limit is a live account
 * condition, and a server restart re-learning it from the next signal is
 * cheaper and safer than persisting a potentially stale verdict.
 *
 * @module provider/Services/ProviderInstanceHealth
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderInstanceRateLimitState {
  /** Unix ms when the limit is expected to lift; null = provider gave no reset time. */
  readonly until: number | null;
  /** Human-readable cause, used in the failover thread activity. */
  readonly reason: string;
  /** Unix ms when the limiting signal was observed. */
  readonly reportedAt: number;
}

export interface ProviderInstanceUsageSnapshot {
  readonly instanceId: ProviderInstanceId;
  readonly payload: unknown;
  /** Unix ms when the payload was observed. */
  readonly observedAt: number;
}

export interface ProviderInstanceHealthShape {
  /**
   * Ingest a raw `account.rate-limits.updated` payload for an instance.
   * Only payload shapes that carry an explicit allow/reject verdict (the
   * Claude SDK's `rate_limit_info`) change state; usage-percentage shapes
   * are ignored — utilization is not a rejection.
   */
  readonly reportRateLimitPayload: (
    instanceId: ProviderInstanceId,
    payload: unknown,
  ) => Effect.Effect<void>;

  /** Store the latest opaque provider usage payload for one instance. */
  readonly reportUsageSnapshot: (
    instanceId: ProviderInstanceId,
    payload: unknown,
  ) => Effect.Effect<void>;

  readonly listUsageSnapshots: () => Effect.Effect<ReadonlyArray<ProviderInstanceUsageSnapshot>>;

  /**
   * Ingest a turn outcome. A successful turn proves the instance healthy
   * and clears any limit; a failure whose message classifies as a rate
   * limit marks it limited.
   */
  readonly reportTurnOutcome: (
    instanceId: ProviderInstanceId,
    outcome: "success" | "failed",
    errorMessage?: string,
  ) => Effect.Effect<void>;

  /**
   * Current rate-limit state, or undefined when the instance is not known
   * to be limited (including when a previous limit has expired).
   */
  readonly getRateLimitState: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRateLimitState | undefined>;
}

export class ProviderInstanceHealth extends Context.Service<
  ProviderInstanceHealth,
  ProviderInstanceHealthShape
>()("t3/provider/Services/ProviderInstanceHealth") {}
