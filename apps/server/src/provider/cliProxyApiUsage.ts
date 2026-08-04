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
import type {
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceUsageSource,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ProviderAdapterRequestError, type ProviderAdapterError } from "./Errors.ts";

export const CLIPROXYAPI_USAGE_SOURCE_KIND = "cliproxyapi";
export const CLIPROXYAPI_USAGE_PAYLOAD_SOURCE = "cliproxyapi.management";

const AUTH_FAILURE_COOLDOWN_MS = 10 * 60 * 1_000;
const AUTH_FILES_REQUEST_TIMEOUT_MS = 5_000;
/**
 * Fixed per-account timeout. The refresh coordinator bounds a whole provider
 * probe at 30 seconds, so a two-wide queue stays inside that for pools up to
 * roughly seven accounts — past that a uniformly slow gateway loses the
 * snapshot rather than returning a page of timeout rows, which is the honest
 * trade for a pool that size.
 */
const ACCOUNT_REQUEST_TIMEOUT_MS = 8_000;
const ACCOUNT_REQUEST_CONCURRENCY = 2;

/**
 * Rejected management keys are rate-limited by the gateway *per source IP*
 * (five inside 30 minutes earns a 30-minute ban that also covers the agent
 * traffic this machine routes through the same host). The cooldown therefore
 * cannot live in a per-configuration closure: re-typing a mistyped key builds
 * a new probe, and a user who cannot see why the meter is empty will do
 * exactly that. Strikes are counted per gateway origin, process-wide.
 *
 * A *different* key still probes immediately — that is the corrected-key case
 * worth serving — until the strike budget is spent, which keeps this well
 * under the gateway's own limit.
 */
const GATEWAY_STRIKE_WINDOW_MS = 30 * 60 * 1_000;
const GATEWAY_STRIKE_BUDGET = 3;

interface GatewayAuthFailureState {
  firstFailureAtMs: number;
  lastFailureAtMs: number;
  lastKey: string;
  count: number;
}

const gatewayAuthFailures = new Map<string, GatewayAuthFailureState>();

// Management rejections are budgeted per origin, so probes for separate
// provider instances sharing one gateway must pass through the same admission
// lane. Per-probe account reads remain concurrent inside the lane.
const gatewayProbeLocks = new Map<string, Semaphore.Semaphore>();

/**
 * A rejected *client* key must not be retried on every probe either: the
 * gateway's per-IP rejection budget is only documented for management keys,
 * but nothing guarantees it is endpoint-scoped, and this machine's live agent
 * traffic rides the same IP. One 401/403 suppresses the models fetch for that
 * origin until the configured key changes.
 */
const rejectedModelCatalogKeys = new Map<string, string>();
const modelCatalogLocks = new Map<string, Semaphore.Semaphore>();

function lockForOrigin(
  locks: Map<string, Semaphore.Semaphore>,
  origin: string,
): Semaphore.Semaphore {
  const existing = locks.get(origin);
  if (existing !== undefined) return existing;
  const created = Semaphore.makeUnsafe(1);
  locks.set(origin, created);
  return created;
}

/** Test-only: drop the process-wide strike ledgers between cases. */
export function resetCliProxyApiAuthFailuresForTest(): void {
  gatewayAuthFailures.clear();
  rejectedModelCatalogKeys.clear();
  gatewayProbeLocks.clear();
  modelCatalogLocks.clear();
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const decodeJsonBody = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

export interface CliProxyApiUsageProbeTarget {
  readonly managementUrl: string;
  readonly managementKey: string;
  readonly clientUrl?: string;
  readonly clientKey?: string;
}

export function cliProxyApiUsageProbeTargetsEqual(
  left: CliProxyApiUsageProbeTarget,
  right: CliProxyApiUsageProbeTarget,
): boolean {
  return (
    left.managementUrl === right.managementUrl &&
    left.managementKey === right.managementKey &&
    left.clientUrl === right.clientUrl &&
    left.clientKey === right.clientKey
  );
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
  readonly modelProviders?: Readonly<Record<string, string>>;
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
 * the instance's Anthropic- or OpenAI-compatible base URL supplies it.
 */
export function resolveCliProxyApiUsageProbeTarget(
  envelope: CliProxyApiUsageEnvelope,
  preferredDriver?: ProviderDriverKind | null,
): CliProxyApiUsageProbeTarget | null {
  const usageSource = envelope.usageSource;
  if (usageSource?.kind !== CLIPROXYAPI_USAGE_SOURCE_KIND) return null;
  if (usageSource.managementKey.length === 0) return null;

  const origin = (value: string | undefined): string | null => {
    if (!value) return null;
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };
  const environmentValue = (name: string): string | undefined =>
    envelope.environment?.find((variable) => variable.name === name)?.value;
  const anthropicClient = {
    url: origin(environmentValue("ANTHROPIC_BASE_URL")),
    key: environmentValue("ANTHROPIC_AUTH_TOKEN"),
  };
  const openAiClient = {
    url: origin(environmentValue("OPENAI_BASE_URL")),
    key: environmentValue("OPENAI_API_KEY"),
  };
  const clients =
    preferredDriver === "codex" ? [openAiClient, anthropicClient] : [anthropicClient, openAiClient];
  const client = clients.find((candidate) => candidate.url !== null && candidate.key);
  const explicitManagementUrl = origin(usageSource.managementUrl);
  if (usageSource.managementUrl !== undefined && explicitManagementUrl === null) return null;
  const managementUrl =
    explicitManagementUrl ??
    client?.url ??
    clients.find((candidate) => candidate.url !== null)?.url;
  if (!managementUrl) return null;
  const base = { managementUrl, managementKey: usageSource.managementKey };
  return client?.url && client.key
    ? { ...base, clientUrl: client.url, clientKey: client.key }
    : base;
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

function parseModelProviders(payload: unknown): Record<string, string> | null {
  const models = asRecord(payload)?.data;
  if (!Array.isArray(models)) return null;
  const providers: Record<string, string> = {};
  for (const value of models) {
    const model = asRecord(value);
    const id = asString(model?.id);
    const ownedBy = asString(model?.owned_by);
    if (id === null) continue;
    if (ownedBy === "anthropic") providers[id] = "claude";
    if (ownedBy === "openai") providers[id] = "codex";
  }
  return Object.keys(providers).length > 0 ? providers : null;
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
 * while the gateway's auth-failure cooldown is active (see
 * `gatewayAuthFailures` — that state is deliberately process-wide, not
 * per-closure).
 */
export function makeCliProxyApiUsageProbe(
  target: CliProxyApiUsageProbeTarget,
): () => Effect.Effect<unknown | undefined, ProviderAdapterError, HttpClient.HttpClient> {
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
      const response = yield* client.execute(
        request.pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${target.managementKey}`),
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
      // The timeout wraps the body read too: `execute` resolves at headers, so
      // a gateway that stalls mid-body would otherwise escape the budget and
      // let the coordinator's own 30s deadline discard the whole snapshot.
    }).pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError((cause) =>
        cause instanceof CliProxyApiAuthRejectedError ||
        cause instanceof CliProxyApiRequestFailedError
          ? cause
          : new CliProxyApiRequestFailedError({
              detail: "CLIProxyAPI management request failed.",
              cause,
            }),
      ),
    );

  const modelProvidersEffect = (() => {
    const { clientUrl, clientKey } = target;
    if (clientUrl === undefined || clientKey === undefined) return Effect.succeed(null);
    return lockForOrigin(modelCatalogLocks, clientUrl)
      .withPermits(1)(
        Effect.gen(function* () {
          if (rejectedModelCatalogKeys.get(clientUrl) === clientKey) return null;
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.execute(
            HttpClientRequest.get(`${clientUrl}/v1/models`).pipe(
              HttpClientRequest.setHeader("Authorization", `Bearer ${clientKey}`),
            ),
          );
          if (response.status === 401 || response.status === 403) {
            rejectedModelCatalogKeys.set(clientUrl, clientKey);
            return null;
          }
          if (response.status < 200 || response.status >= 300) return null;
          return parseModelProviders(yield* response.json);
        }),
      )
      .pipe(
        Effect.timeout(AUTH_FILES_REQUEST_TIMEOUT_MS),
        Effect.orElseSucceed(() => null),
      );
  })();

  const probeAccount = (entry: AuthFileEntry, timeoutMs: number) =>
    Effect.gen(function* () {
      const failed = (error: string): CliProxyApiUsageAccount => ({
        ...entry.account,
        usage: null,
        error,
      });

      const request = upstreamUsageRequest(entry.account.provider);
      if (!request) {
        return { ...entry.account, usage: null } satisfies CliProxyApiUsageAccount;
      }
      if (entry.authIndex.length === 0) {
        return failed("Gateway account has no auth index.");
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
        return failed(result.message);
      }

      const call = asRecord(result.value);
      const statusCode = asFiniteNumber(call?.status_code);
      const bodyText = asString(call?.body);
      if (statusCode !== 200 || bodyText === null) {
        return failed(`Upstream usage read failed (HTTP ${statusCode ?? "unknown"}).`);
      }
      const body = asRecord(yield* decodeJsonBody(bodyText).pipe(Effect.orElseSucceed(() => null)));
      if (!body) {
        return failed("Upstream usage body was not JSON.");
      }

      if (entry.account.provider === "codex") {
        const translated = translateCodexUsage(body);
        if (Object.keys(asRecord(translated.usage) ?? {}).length === 0) {
          return failed("Upstream usage body had no rate-limit windows.");
        }
        return {
          ...entry.account,
          usage: translated.usage,
          ...(translated.planType !== null ? { planType: translated.planType } : {}),
        } satisfies CliProxyApiUsageAccount;
      }
      if (Object.keys(body).length === 0) {
        return failed("Upstream usage body had no rate-limit data.");
      }
      return {
        ...entry.account,
        usage: { source: "claude.usage-api", rateLimits: body },
      } satisfies CliProxyApiUsageAccount;
    });

  const probe = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const failures = gatewayAuthFailures.get(target.managementUrl);
    if (failures !== undefined) {
      if (now - failures.firstFailureAtMs >= GATEWAY_STRIKE_WINDOW_MS) {
        gatewayAuthFailures.delete(target.managementUrl);
      } else if (
        failures.count >= GATEWAY_STRIKE_BUDGET ||
        (failures.lastKey === target.managementKey &&
          now - failures.lastFailureAtMs < AUTH_FAILURE_COOLDOWN_MS)
      ) {
        // Fail without touching the gateway: a silent skip would leave a
        // manual refresh looking like a signed-out account, when the real
        // story is the rejected-key pause.
        return yield* new ProviderAdapterRequestError({
          provider: "cliproxyapi",
          method: "account/usage",
          detail:
            "The gateway rejected the management key earlier; probes are " +
            "paused to avoid the gateway's 30-minute IP ban. Fix the key " +
            "or wait for the pause to lapse.",
        });
      }
    }

    const modelProvidersFiber = yield* modelProvidersEffect.pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const authFiles = yield* managementRequest(
      HttpClientRequest.get(`${target.managementUrl}/v0/management/auth-files`),
      AUTH_FILES_REQUEST_TIMEOUT_MS,
    );
    const entries = parseAuthFiles(authFiles);
    if (entries.length === 0) {
      return undefined;
    }

    const accounts = yield* Effect.forEach(
      entries,
      (entry) => probeAccount(entry, ACCOUNT_REQUEST_TIMEOUT_MS),
      { concurrency: ACCOUNT_REQUEST_CONCURRENCY },
    );
    const modelProviders = yield* Fiber.join(modelProvidersFiber);
    const payload: CliProxyApiUsagePayload = {
      source: CLIPROXYAPI_USAGE_PAYLOAD_SOURCE,
      accounts,
      ...(modelProviders !== null ? { modelProviders } : {}),
    };
    return payload as unknown;
  }).pipe(
    Effect.catchTags({
      CliProxyApiAuthRejectedError: (error) =>
        Effect.gen(function* () {
          const failedAtMs = yield* Clock.currentTimeMillis;
          const previous = gatewayAuthFailures.get(target.managementUrl);
          const withinWindow =
            previous !== undefined &&
            failedAtMs - previous.firstFailureAtMs < GATEWAY_STRIKE_WINDOW_MS;
          const count = withinWindow ? previous.count + 1 : 1;
          gatewayAuthFailures.set(target.managementUrl, {
            firstFailureAtMs: withinWindow ? previous.firstFailureAtMs : failedAtMs,
            lastFailureAtMs: failedAtMs,
            lastKey: target.managementKey,
            count,
          });
          const spent = count >= GATEWAY_STRIKE_BUDGET;
          return yield* new ProviderAdapterRequestError({
            provider: "cliproxyapi",
            method: "account/usage",
            detail:
              `${error.message} ` +
              (spent
                ? `This gateway has now been refused ${count} times; probes stop until the ` +
                  `${Math.round(GATEWAY_STRIKE_WINDOW_MS / 60_000)}-minute window elapses.`
                : `Retrying with the same key is paused for ` +
                  `${Math.round(AUTH_FAILURE_COOLDOWN_MS / 60_000)} minutes.`) +
              " Repeated rejected management keys trigger the gateway's 30-minute IP ban.",
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

  return () => lockForOrigin(gatewayProbeLocks, target.managementUrl).withPermits(1)(probe);
}
