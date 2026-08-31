import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/**
 * OpenRouter account credits, read server-side with the user's OpenRouter API
 * key (`GET /api/v1/credits`). The balance is account-wide — not tied to any
 * provider instance — so it travels outside the provider-usage snapshot
 * pipeline. OpenRouter caches these values for about a minute; the server
 * mirrors that with its own cache, so a read is always safe to issue.
 */
export const OpenRouterCreditsSnapshot = Schema.Struct({
  /** Lifetime credits purchased, in USD. */
  totalCreditsUsd: Schema.Number.check(Schema.isFinite()),
  /** Lifetime credits spent, in USD. The balance is the difference. */
  totalUsageUsd: Schema.Number.check(Schema.isFinite()),
  /** Unix milliseconds when the server fetched this from OpenRouter. */
  observedAt: NonNegativeInt,
});
export type OpenRouterCreditsSnapshot = typeof OpenRouterCreditsSnapshot.Type;

export const OpenRouterCreditsReadInput = Schema.Struct({});
export type OpenRouterCreditsReadInput = typeof OpenRouterCreditsReadInput.Type;

export const OpenRouterCreditsResult = Schema.Struct({
  /** Whether this environment holds an OpenRouter API key. */
  configured: Schema.Boolean,
  /** Null when unconfigured or when the read failed (see `error`). */
  snapshot: Schema.NullOr(OpenRouterCreditsSnapshot),
  /** Why a configured key produced no snapshot; safe to render verbatim. */
  error: Schema.optional(Schema.String),
});
export type OpenRouterCreditsResult = typeof OpenRouterCreditsResult.Type;

export const OpenRouterCreditsConfigureInput = Schema.Struct({
  /**
   * The OpenRouter API key to store in this environment's secret store. An
   * empty string removes the stored key. Never echoed back to clients.
   */
  apiKey: Schema.String,
});
export type OpenRouterCreditsConfigureInput = typeof OpenRouterCreditsConfigureInput.Type;

export const OpenRouterCreditsConfigureResult = Schema.Struct({
  configured: Schema.Boolean,
});
export type OpenRouterCreditsConfigureResult = typeof OpenRouterCreditsConfigureResult.Type;
