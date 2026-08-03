/**
 * CLIProxyAPI gateway usage probe.
 *
 * A provider instance whose `usageSource.kind` is `cliproxyapi` fronts a pool
 * of upstream subscriptions behind one Anthropic-compatible endpoint. The
 * driver's own account probe runs a bearer-token session with no subscription
 * attached, so the SDK reports `rate_limits_available: false` and the usage
 * meter has nothing to show. The meaningful quota lives with the gateway's
 * management API:
 *
 *   - `GET  /v0/management/auth-files` — the pooled accounts with priority
 *     tier and cooldown state.
 *   - `POST /v0/management/api-call` — re-signs an upstream usage read with
 *     that account's live OAuth token server-side
 *     (`api.anthropic.com/api/oauth/usage` for Claude,
 *     `chatgpt.com/backend-api/wham/usage` for Codex).
 *
 * The probe emits one snapshot per instance carrying every pooled account.
 * Per-account usage is normalized here into the same payload shapes the
 * matching direct providers already report (Claude structured usage-API,
 * Codex rate-limit windows), so the client-side window normalizer is reused
 * verbatim and this module stays the only place that knows gateway shapes.
 *
 * Auth failures are terminal for a while: the gateway bans an IP for 30
 * minutes after five rejected management keys, so after a 401/403 the probe
 * refuses to contact the gateway again for a cooldown period rather than
 * letting popover-driven refreshes spend ban strikes.
 */
import type { ProviderInstanceEnvironment, ProviderInstanceUsageSource } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ProviderAdapterRequestError, type ProviderAdapterError } from "./Errors.ts";

export const CLIPROXYAPI_USAGE_SOURCE_KIND = "cliproxyapi";
export const CLIPROXYAPI_USAGE_PAYLOAD_SOURCE = "cliproxyapi.management";

const AUTH_FAILURE_COOLDOWN_MS = 10 * 60 * 1_000;
const AUTH_FILES_REQUEST_TIMEOUT_MS = 5_000;
const ACCOUNT_REQUEST_BUDGET_MS = 22_000;
const ACCOUNT_REQUEST_CONCURRENCY = 2;

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const decodeJsonBody = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

export interface CliProxyApiUsageProbeTarget {
  readonly managementUrl: string;
  readonly managementKey: string;
}

export type CliProxyApiAccountState = "available" | "disabled" | "cooldown";

export interface CliProxyApiUsageAccount {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly priority: number | null;
  readonly state: CliProxyApiAccountState;
  readonly planType?: string;
  /**
   * Account usage in the same payload shape the matching direct provider
   * reports (`{ source: "claude.usage-api", rateLimits }` for Claude, the
   * rate-limit window shape for Codex), or null when this account's upstream
   * probe failed or the provider has no known usage endpoint.
   */
  readonly usage: unknown;
  readonly error?: string;
}

export interface CliProxyApiUsagePayload {
  readonly source: typeof CLIPROXYAPI_USAGE_PAYLOAD_SOURCE;
  readonly accounts: ReadonlyArray<CliProxyApiUsageAccount>;
}

class CliProxyApiAuthRejectedError extends Data.TaggedError("CliProxyApiAuthRejectedError")<{
  readonly status: number;
}> {
  override get message(): string {
    return `CLIProxyAPI management authentication rejected (HTTP ${this.status}).`;
  }
}

class CliProxyApiRequestFailedError extends Data.TaggedError("CliProxyApiRequestFailedError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The envelope fields the probe target derives from. */
export interface CliProxyApiUsageEnvelope {
  readonly environment?: ProviderInstanceEnvironment | undefined;
  readonly usageSource?: ProviderInstanceUsageSource | undefined;
}

/**
 * Resolve the probe target from an instance envelope. The management API
 * shares the gateway's origin, so when `managementUrl` is not set explicitly
 * the instance's `ANTHROPIC_BASE_URL` environment entry supplies it.
 */
export function resolveCliProxyApiUsageProbeTarget(
  envelope: CliProxyApiUsageEnvelope,
): CliProxyApiUsageProbeTarget | null {
  const usageSource = envelope.usageSource;
  if (usageSource?.kind !== CLIPROXYAPI_USAGE_SOURCE_KIND) return null;
  if (usageSource.managementKey.length === 0) return null;

  const configuredUrl =
    usageSource.managementUrl ??
    envelope.environment?.find((variable) => variable.name === "ANTHROPIC_BASE_URL")?.value;
  if (!configuredUrl) return null;
  try {
    return {
      managementUrl: new URL(configuredUrl).origin,
      managementKey: usageSource.managementKey,
    };
  } catch {
    return null;
  }
}

interface AuthFileEntry {
  readonly authIndex: string;
  readonly account: Omit<CliProxyApiUsageAccount, "usage" | "error">;
}

function parseAuthFiles(payload: unknown): AuthFileEntry[] {
  const files = asRecord(payload)?.files;
  if (!Array.isArray(files)) return [];
  const entries: AuthFileEntry[] = [];
  for (const [index, value] of files.entries()) {
    const file = asRecord(value);
    if (!file) continue;
    const authIndex = asString(file.auth_index) ?? asFiniteNumber(file.auth_index)?.toString();
    const name = asString(file.name);
    const label = asString(file.label) ?? asString(file.email) ?? name ?? `Account ${index + 1}`;
    entries.push({
      authIndex: authIndex ?? "",
      account: {
        id: name ?? authIndex ?? `account-${index}`,
        label,
        provider: asString(file.provider) ?? "unknown",
        priority: asFiniteNumber(file.priority),
        state:
          file.disabled === true
            ? "disabled"
            : file.unavailable === true
              ? "cooldown"
              : "available",
      },
    });
  }
  return entries;
}

/**
 * Translate the raw `wham/usage` body into the rate-limit window shape the
 * Codex app-server reports, so the client's existing Codex normalizer renders
 * gateway accounts identically to a direct Codex instance. The per-model
 * `additional_rate_limits` are intentionally dropped for parity with what a
 * direct Codex instance reports (primary/secondary only).
 */
function translateCodexUsage(body: Record<string, unknown>): {
  readonly usage: unknown;
  readonly planType: string | null;
} {
  const rateLimit = asRecord(body.rate_limit);
  const translateWindow = (value: unknown): Record<string, unknown> | undefined => {
    const window = asRecord(value);
    if (!window) return undefined;
    const usedPercent = asFiniteNumber(window.used_percent);
    if (usedPercent === null) return undefined;
    const windowSeconds = asFiniteNumber(window.limit_window_seconds);
    return {
      usedPercent,
      ...(windowSeconds !== null ? { windowDurationMins: Math.round(windowSeconds / 60) } : {}),
      ...(asFiniteNumber(window.reset_at) !== null ? { resetsAt: window.reset_at } : {}),
    };
  };
  const primary = translateWindow(rateLimit?.primary_window);
  const secondary = translateWindow(rateLimit?.secondary_window);
  return {
    usage: {
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
    },
    planType: asString(body.plan_type),
  };
}

interface UpstreamUsageRequest {
  readonly url: string;
  readonly header: Record<string, string>;
}

function upstreamUsageRequest(provider: string): UpstreamUsageRequest | null {
  switch (provider) {
    case "claude":
      return {
        url: CLAUDE_USAGE_URL,
        header: {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
        },
      };
    case "codex":
      return {
        url: CODEX_USAGE_URL,
        header: {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
          "User-Agent": "codex_cli_rs/0.104.0",
        },
      };
    default:
      return null;
  }
}

/**
 * Build a `readAccountUsage`-compatible probe bound to one gateway target.
 * The returned effect resolves to the instance's usage payload, or undefined
 * while the auth-failure cooldown is active. Auth-failure state lives in this
 * closure, so callers must reuse one probe per instance configuration.
 */
export function makeCliProxyApiUsageProbe(
  target: CliProxyApiUsageProbeTarget,
): () => Effect.Effect<unknown | undefined, ProviderAdapterError, HttpClient.HttpClient> {
  let authFailedAtMs: number | undefined;

  const managementRequest = (
    request: HttpClientRequest.HttpClientRequest,
    timeoutMs: number,
  ): Effect.Effect<
    unknown,
    CliProxyApiAuthRejectedError | CliProxyApiRequestFailedError,
    HttpClient.HttpClient
  > =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .execute(
          request.pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${target.managementKey}`),
          ),
        )
        .pipe(
          Effect.timeout(timeoutMs),
          Effect.mapError(
            (cause) =>
              new CliProxyApiRequestFailedError({
                detail: "CLIProxyAPI management request failed.",
                cause,
              }),
          ),
        );
      if (response.status === 401 || response.status === 403) {
        return yield* new CliProxyApiAuthRejectedError({ status: response.status });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new CliProxyApiRequestFailedError({
          detail: `CLIProxyAPI management request failed (HTTP ${response.status}).`,
        });
      }
      return yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new CliProxyApiRequestFailedError({
              detail: "CLIProxyAPI management response was not JSON.",
              cause,
            }),
        ),
      );
    });

  const probeAccount = (entry: AuthFileEntry, timeoutMs: number) =>
    Effect.gen(function* () {
      const request = upstreamUsageRequest(entry.account.provider);
      if (!request) {
        return { ...entry.account, usage: null } satisfies CliProxyApiUsageAccount;
      }
      if (entry.authIndex.length === 0) {
        return {
          ...entry.account,
          usage: null,
          error: "Gateway account has no auth index.",
        } satisfies CliProxyApiUsageAccount;
      }
      // Auth rejection aborts the whole probe (ban-strike budget); any other
      // per-account failure degrades to an error row instead.
      const result = yield* managementRequest(
        HttpClientRequest.post(`${target.managementUrl}/v0/management/api-call`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            auth_index: entry.authIndex,
            method: "GET",
            url: request.url,
            header: request.header,
          }),
        ),
        timeoutMs,
      ).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catchTag("CliProxyApiRequestFailedError", (error) =>
          Effect.succeed({ ok: false as const, message: error.detail }),
        ),
      );
      if (!result.ok) {
        return {
          ...entry.account,
          usage: null,
          error: result.message,
        } satisfies CliProxyApiUsageAccount;
      }

      const call = asRecord(result.value);
      const statusCode = asFiniteNumber(call?.status_code);
      const bodyText = asString(call?.body);
      if (statusCode !== 200 || bodyText === null) {
        return {
          ...entry.account,
          usage: null,
          error: `Upstream usage read failed (HTTP ${statusCode ?? "unknown"}).`,
        } satisfies CliProxyApiUsageAccount;
      }
      const body = asRecord(yield* decodeJsonBody(bodyText).pipe(Effect.orElseSucceed(() => null)));
      if (!body) {
        return {
          ...entry.account,
          usage: null,
          error: "Upstream usage body was not JSON.",
        } satisfies CliProxyApiUsageAccount;
      }

      if (entry.account.provider === "codex") {
        const translated = translateCodexUsage(body);
        if (Object.keys(asRecord(translated.usage) ?? {}).length === 0) {
          return {
            ...entry.account,
            usage: null,
            error: "Upstream usage body had no rate-limit windows.",
          } satisfies CliProxyApiUsageAccount;
        }
        return {
          ...entry.account,
          usage: translated.usage,
          ...(translated.planType !== null ? { planType: translated.planType } : {}),
        } satisfies CliProxyApiUsageAccount;
      }
      if (Object.keys(body).length === 0) {
        return {
          ...entry.account,
          usage: null,
          error: "Upstream usage body had no rate-limit data.",
        } satisfies CliProxyApiUsageAccount;
      }
      return {
        ...entry.account,
        usage: { source: "claude.usage-api", rateLimits: body },
      } satisfies CliProxyApiUsageAccount;
    });

  return () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (authFailedAtMs !== undefined && now - authFailedAtMs < AUTH_FAILURE_COOLDOWN_MS) {
        return undefined;
      }
      authFailedAtMs = undefined;

      const authFiles = yield* managementRequest(
        HttpClientRequest.get(`${target.managementUrl}/v0/management/auth-files`),
        AUTH_FILES_REQUEST_TIMEOUT_MS,
      );
      const entries = parseAuthFiles(authFiles);
      if (entries.length === 0) {
        return undefined;
      }

      // The refresh coordinator bounds a whole provider probe at 30 seconds.
      // Share a smaller fixed budget across the two-wide account queue so any
      // number of slow accounts still resolves to error rows before that outer
      // deadline instead of discarding the entire pool snapshot.
      const accountRequestTimeoutMs = Math.max(
        1,
        Math.floor(
          ACCOUNT_REQUEST_BUDGET_MS / Math.ceil(entries.length / ACCOUNT_REQUEST_CONCURRENCY),
        ),
      );
      const accounts = yield* Effect.forEach(
        entries,
        (entry) => probeAccount(entry, accountRequestTimeoutMs),
        { concurrency: ACCOUNT_REQUEST_CONCURRENCY },
      );
      const payload: CliProxyApiUsagePayload = {
        source: CLIPROXYAPI_USAGE_PAYLOAD_SOURCE,
        accounts,
      };
      return payload as unknown;
    }).pipe(
      Effect.catchTags({
        CliProxyApiAuthRejectedError: (error) =>
          Effect.gen(function* () {
            authFailedAtMs = yield* Clock.currentTimeMillis;
            return yield* new ProviderAdapterRequestError({
              provider: "cliproxyapi",
              method: "account/usage",
              detail:
                `${error.message} Further probes are paused for ` +
                `${Math.round(AUTH_FAILURE_COOLDOWN_MS / 60_000)} minutes: repeated rejected ` +
                "management keys trigger the gateway's 30-minute IP ban.",
              cause: error,
            });
          }),
        CliProxyApiRequestFailedError: (error) =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "cliproxyapi",
              method: "account/usage",
              detail: error.detail,
              cause: error.cause,
            }),
          ),
      }),
    );
}
