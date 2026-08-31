/**
 * OpenRouter account-credits reader.
 *
 * The balance is account-wide, so it lives outside the per-instance
 * provider-usage pipeline: one API key per environment, stored in the
 * server's secret store, read with `GET /api/v1/credits`. OpenRouter caches
 * the endpoint's values for about a minute, so the reader keeps its own
 * 60-second cache and reads are always safe to issue on popover open.
 *
 * Cache and single-flight state are process-wide, not per-closure: the WS
 * handler layer is built per connection, and two clients opening their usage
 * popovers must share one upstream request, not race two.
 */
import type { OpenRouterCreditsResult, OpenRouterCreditsSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const OPENROUTER_API_KEY_SECRET_NAME = "openrouter-credits-api-key";

const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const CACHE_TTL_MS = 60_000;
/**
 * How long a failed fetch answers later reads without contacting OpenRouter.
 * Waiters queue on the single-flight gate, so without this an outage would
 * make every queued reader spend its own doomed request in turn, each up to
 * the full request timeout.
 */
const FAILURE_CACHE_TTL_MS = 10_000;
const REQUEST_TIMEOUT = "10 seconds";

// Finite on purpose: JSON like `1e400` decodes to Infinity, and an
// Infinity-minus-Infinity balance would render as NaN on the client.
const CreditsBody = Schema.Struct({
  data: Schema.Struct({
    total_credits: Schema.Number.check(Schema.isFinite()),
    total_usage: Schema.Number.check(Schema.isFinite()),
  }),
});
const decodeCreditsBody = Schema.decodeUnknownEffect(Schema.fromJsonString(CreditsBody));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface CreditsCacheEntry {
  readonly apiKey: string;
  readonly snapshot: OpenRouterCreditsSnapshot;
}

interface CreditsFailureEntry {
  readonly apiKey: string;
  readonly reason: string;
  readonly atMs: number;
}

let creditsCache: CreditsCacheEntry | null = null;
let creditsFailure: CreditsFailureEntry | null = null;
const fetchGate = Semaphore.makeUnsafe(1);

/** Test-only: drop the process-wide cache between cases. */
export function resetOpenRouterCreditsCacheForTest(): void {
  creditsCache = null;
  creditsFailure = null;
}

class CreditsFetchError {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

const fetchSnapshot = (
  apiKey: string,
): Effect.Effect<OpenRouterCreditsSnapshot, CreditsFetchError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(OPENROUTER_CREDITS_URL).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey}`),
      ),
    );
    if (response.status === 401 || response.status === 403) {
      return yield* Effect.fail(
        new CreditsFetchError(
          "OpenRouter rejected the key. The credits endpoint needs a management key " +
            "(openrouter.ai/settings/management-keys), not a regular inference key.",
        ),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new CreditsFetchError(`OpenRouter answered with status ${response.status}.`),
      );
    }
    const body = yield* response.text.pipe(
      Effect.flatMap(decodeCreditsBody),
      Effect.mapError(
        () => new CreditsFetchError("OpenRouter answered with an unexpected payload."),
      ),
    );
    const observedAt = yield* Clock.currentTimeMillis;
    return {
      totalCreditsUsd: body.data.total_credits,
      totalUsageUsd: body.data.total_usage,
      observedAt,
    };
  }).pipe(
    // The timeout covers the whole exchange, body read included: a response
    // that hangs after its headers would otherwise hold the single-flight
    // gate forever and wedge every later read in this process.
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.catchCause((cause) => {
      const squashed = Cause.squash(cause);
      if (squashed instanceof CreditsFetchError) {
        return Effect.fail(squashed);
      }
      return Effect.fail(
        new CreditsFetchError(
          Cause.isTimeoutError(squashed)
            ? "The OpenRouter request timed out."
            : "Could not reach OpenRouter.",
        ),
      );
    }),
  );

/**
 * Read the environment's OpenRouter credits. Never fails: a missing key,
 * a rejected key, or an unreachable endpoint all land in the result, where
 * the client renders them, and a fetch failure keeps the last snapshot so a
 * blip does not blank a number that was on screen.
 */
export const readOpenRouterCredits: Effect.Effect<
  OpenRouterCreditsResult,
  never,
  HttpClient.HttpClient | ServerSecretStore.ServerSecretStore
> = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const stored = yield* secretStore.get(OPENROUTER_API_KEY_SECRET_NAME).pipe(
    Effect.map(Option.some),
    // A store that cannot be read is not "no key configured" — saying so
    // would send the user off to re-add a key that is already there.
    Effect.catch((error) =>
      Effect.logWarning("Failed to read the OpenRouter API key.", { cause: error }).pipe(
        Effect.as(Option.none<Option.Option<Uint8Array>>()),
      ),
    ),
  );
  if (Option.isNone(stored)) {
    return {
      configured: false,
      snapshot: null,
      error: "Could not read the stored OpenRouter API key.",
    };
  }
  if (Option.isNone(stored.value)) {
    return { configured: false, snapshot: null };
  }
  const apiKey = textDecoder.decode(stored.value.value).trim();
  if (apiKey.length === 0) {
    return { configured: false, snapshot: null };
  }
  // Single-flight: concurrent readers wait for the first fetch and then hit
  // the cache it filled instead of each spending an upstream request.
  return yield* fetchGate.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = creditsCache;
      if (
        cached !== null &&
        cached.apiKey === apiKey &&
        now - cached.snapshot.observedAt < CACHE_TTL_MS
      ) {
        return { configured: true, snapshot: cached.snapshot };
      }
      const staleSnapshot = cached !== null && cached.apiKey === apiKey ? cached.snapshot : null;
      // Readers queued behind a failed fetch get the recorded failure instead
      // of each spending their own doomed request in turn.
      const failure = creditsFailure;
      if (
        failure !== null &&
        failure.apiKey === apiKey &&
        now - failure.atMs < FAILURE_CACHE_TTL_MS
      ) {
        return { configured: true, snapshot: staleSnapshot, error: failure.reason };
      }
      return yield* fetchSnapshot(apiKey).pipe(
        Effect.map((snapshot) => {
          creditsCache = { apiKey, snapshot };
          creditsFailure = null;
          return { configured: true, snapshot };
        }),
        Effect.catch((error: CreditsFetchError) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((failedAtMs) => {
              creditsFailure = { apiKey, reason: error.reason, atMs: failedAtMs };
              return {
                configured: true,
                // A stale snapshot for the same key stays visible; its
                // `observedAt` says how old it is.
                snapshot: staleSnapshot,
                error: error.reason,
              };
            }),
          ),
        ),
      );
    }),
  );
});

/**
 * Store or clear the environment's OpenRouter API key. An empty (or
 * whitespace-only) key removes the stored secret. Secret-store failures
 * propagate so the caller's command surfaces them instead of reporting a
 * configuration that did not happen.
 */
export const configureOpenRouterCredits = (
  apiKey: string,
): Effect.Effect<
  { readonly configured: boolean },
  ServerSecretStore.SecretStoreError,
  ServerSecretStore.ServerSecretStore
> =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const trimmed = apiKey.trim();
    creditsCache = null;
    creditsFailure = null;
    if (trimmed.length === 0) {
      yield* secretStore.remove(OPENROUTER_API_KEY_SECRET_NAME);
      return { configured: false };
    }
    yield* secretStore.set(OPENROUTER_API_KEY_SECRET_NAME, textEncoder.encode(trimmed));
    return { configured: true };
  });
