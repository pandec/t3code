import type {
  OrchestrationThreadActivity,
  ProviderInstanceUsageSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Subscription rate-limit usage derived from `account.rate-limits.updated`
 * thread activities. Providers report usage in undocumented, provider-specific
 * shapes that have already drifted between CLI releases, so everything here is
 * defensive: unknown window taxonomies fall back to readable labels instead of
 * being dropped, and payloads that carry no usable data yield no snapshot —
 * a percentage is never fabricated.
 */

/** Windows at or above this usage render as a warning, unless overridden. */
export const PROVIDER_USAGE_WARNING_PERCENT = 80;
/** Windows at or above this usage render as critical, unless overridden. */
export const PROVIDER_USAGE_CRITICAL_PERCENT = 95;

/**
 * Usage percentages at which windows turn amber and red. Web reads these from
 * client settings; mobile does not sync client settings and keeps the defaults.
 */
export type ProviderUsageThresholds = {
  readonly warningPercent: number;
  readonly criticalPercent: number;
};

export const DEFAULT_PROVIDER_USAGE_THRESHOLDS: ProviderUsageThresholds = {
  warningPercent: PROVIDER_USAGE_WARNING_PERCENT,
  criticalPercent: PROVIDER_USAGE_CRITICAL_PERCENT,
};

const MIN_PROVIDER_USAGE_THRESHOLD_PERCENT = 1;
const MAX_PROVIDER_USAGE_THRESHOLD_PERCENT = 100;

function clampThresholdPercent(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(
    MAX_PROVIDER_USAGE_THRESHOLD_PERCENT,
    Math.max(MIN_PROVIDER_USAGE_THRESHOLD_PERCENT, Math.round(value)),
  );
}

/**
 * Clamps both thresholds into 1-100 and keeps warning at or below critical: a
 * warning threshold above the critical one could otherwise mask the critical
 * state entirely, which is the one state the meter exists to surface.
 */
export function normalizeProviderUsageThresholds(
  thresholds: Partial<ProviderUsageThresholds> | undefined,
): ProviderUsageThresholds {
  const criticalPercent = clampThresholdPercent(
    thresholds?.criticalPercent,
    PROVIDER_USAGE_CRITICAL_PERCENT,
  );
  return {
    warningPercent: Math.min(
      clampThresholdPercent(thresholds?.warningPercent, PROVIDER_USAGE_WARNING_PERCENT),
      criticalPercent,
    ),
    criticalPercent,
  };
}

/** A snapshot older than this no longer reflects reality; render nothing. */
const PROVIDER_USAGE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export type ProviderUsageStatus = "ok" | "warning" | "critical";

/**
 * Coarse window class, normalized across providers so surfaces can pick a
 * window to feature without matching provider-specific ids or labels.
 */
export type ProviderUsageWindowGroup = "session" | "weekly" | "other";

export type ProviderUsageWindow = {
  /** Stable identity for merging events and de-duping alerts, e.g. "five_hour". */
  readonly id: string;
  readonly group: ProviderUsageWindowGroup;
  /** Popover row label, e.g. "Session (5h)" or "Weekly (Fable)". */
  readonly label: string;
  /** Compact label for the inline trigger, e.g. "5h" or "Wk". */
  readonly shortLabel: string;
  /** 0-100, or null when the provider signalled state without a number. */
  readonly usedPercent: number | null;
  /** Unix seconds when this window resets, or null if unknown. */
  readonly resetsAt: number | null;
  readonly status: ProviderUsageStatus;
  /**
   * Severity the provider itself signalled (Claude's `rejected`, Codex's
   * exhausted limit), independent of any percentage threshold. Retained so a
   * snapshot can be re-evaluated against different thresholds without losing
   * a state that no percentage implies.
   */
  readonly reportedStatus?: ProviderUsageStatus;
};

export type ProviderUsageSnapshot = {
  readonly providerLabel: string;
  /** Provider account/instance that emitted the contributing activities. */
  readonly providerInstanceId: string | null;
  readonly windows: ReadonlyArray<ProviderUsageWindow>;
  readonly status: ProviderUsageStatus;
  /** The most constrained window; what the collapsed trigger surfaces. */
  readonly constrainedWindow: ProviderUsageWindow | null;
  readonly updatedAt: string;
  /** Window the provider flagged as binding, when it says so. */
  readonly activeWindowId?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Providers report utilization either as a 0-1 ratio or a 0-100 percent. */
function normalizeRatioOrPercent(value: number): number {
  return clampPercent(value <= 1 ? value * 100 : value);
}

function statusForPercent(
  percent: number | null,
  thresholds: ProviderUsageThresholds = DEFAULT_PROVIDER_USAGE_THRESHOLDS,
): ProviderUsageStatus {
  if (percent === null) return "ok";
  if (percent >= thresholds.criticalPercent) return "critical";
  if (percent >= thresholds.warningPercent) return "warning";
  return "ok";
}

function maxStatus(a: ProviderUsageStatus, b: ProviderUsageStatus): ProviderUsageStatus {
  return statusRank(b) > statusRank(a) ? b : a;
}

function statusRank(status: ProviderUsageStatus): number {
  const order: Record<ProviderUsageStatus, number> = { ok: 0, warning: 1, critical: 2 };
  return order[status];
}

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Claude
//
// The Agent SDK emits one `rate_limit_event` per constrained window:
//   { type: "rate_limit_event", rate_limit_info: {
//       status: "allowed" | "allowed_warning" | "rejected",
//       resetsAt: 1784970000,          // camelCase, unix seconds
//       rateLimitType: "five_hour",
//       utilization?: number,          // 0-1; absent at low usage (verified live)
//       surpassedThreshold?: number,   // crossed threshold, not utilization
//       overageStatus?, isUsingOverage?, ... } }
// The rateLimitType taxonomy drifts between releases (the SDK type still lists
// an Opus/Sonnet split that no longer exists, and a Fable weekly window exists
// that predates the type), so unknown values are labelled heuristically, never
// dropped.
// ---------------------------------------------------------------------------

const CLAUDE_WINDOW_LABELS: Record<string, { label: string; shortLabel: string }> = {
  five_hour: { label: "Session (5h)", shortLabel: "5h" },
  seven_day: { label: "Weekly (all models)", shortLabel: "Wk" },
  seven_day_opus: { label: "Weekly (Opus)", shortLabel: "Opus" },
  seven_day_sonnet: { label: "Weekly (Sonnet)", shortLabel: "Sonnet" },
  overage: { label: "Overage", shortLabel: "Overage" },
};

function claudeWindowGroup(rateLimitType: string): ProviderUsageWindowGroup {
  // Hour windows are spelled out ("five_hour") today but have been numeric in
  // other payloads, so match on the suffix rather than a fixed value.
  if (/_hours?$/.test(rateLimitType)) return "session";
  if (rateLimitType.startsWith("seven_day") || /_days?$/.test(rateLimitType)) return "weekly";
  return "other";
}

function claudeWindowLabels(rateLimitType: string): { label: string; shortLabel: string } {
  const known = CLAUDE_WINDOW_LABELS[rateLimitType];
  if (known) return known;
  const weekly = /^seven_day[_-](.+)$/.exec(rateLimitType);
  if (weekly?.[1]) {
    const model = titleCase(weekly[1]);
    return { label: `Weekly (${model})`, shortLabel: model };
  }
  const hourly = /^(\d+)_hour$/.exec(rateLimitType);
  if (hourly?.[1]) {
    return { label: `Session (${hourly[1]}h)`, shortLabel: `${hourly[1]}h` };
  }
  const humanized = titleCase(rateLimitType);
  return { label: humanized, shortLabel: humanized };
}

function normalizeClaudeRateLimitEvent(payload: Record<string, unknown>): {
  providerLabel: "Claude";
  windows: ProviderUsageWindow[];
  clearedWindowIds: string[];
} | null {
  const info = asRecord(payload.rate_limit_info) ?? payload;

  // Tolerate both camelCase (current SDK) and snake_case (older releases).
  const reportedRateLimitType = asString(info.rateLimitType) ?? asString(info.rate_limit_type);
  const rateLimitType = reportedRateLimitType ?? "unknown";
  const status = asString(info.status);
  const resetsAt = asFiniteNumber(info.resetsAt) ?? asFiniteNumber(info.resets_at);
  const utilization = asFiniteNumber(info.utilization);
  const usedPercent = utilization !== null ? normalizeRatioOrPercent(utilization) : null;

  // "allowed" with no number carries no information worth rendering; a
  // non-allowed status without a number still deserves a (numberless) row.
  // When the window id is known, retain a tombstone so this newest event clears
  // an older warning for the same window without fabricating a percentage.
  if (usedPercent === null && (status === null || status === "allowed")) {
    if (status === "allowed" && reportedRateLimitType !== null) {
      return {
        providerLabel: "Claude",
        windows: [],
        clearedWindowIds: [reportedRateLimitType],
      };
    }
    return null;
  }

  const { label, shortLabel } = claudeWindowLabels(rateLimitType);
  const reportedStatus: ProviderUsageStatus =
    status === "rejected" ? "critical" : status === "allowed_warning" ? "warning" : "ok";
  const windowStatus = maxStatus(statusForPercent(usedPercent), reportedStatus);

  return {
    providerLabel: "Claude",
    clearedWindowIds: [],
    windows: [
      {
        id: rateLimitType,
        group: claudeWindowGroup(rateLimitType),
        label,
        shortLabel,
        usedPercent,
        resetsAt,
        status: windowStatus,
        reportedStatus,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Claude structured /usage API
//
// The passive event stream omits utilization at normal usage levels, so the
// adapter also pulls the structured `/usage` payload. Its `limits` array is the
// authoritative source and the only place the model-scoped weekly window (e.g.
// Fable) appears with a percentage:
//   { kind: "weekly_scoped", group: "weekly", percent: 44, severity: "normal",
//     resets_at: "2026-07-31T02:59:59Z", is_active: true,
//     scope: { model: { display_name: "Fable" } } }
// `is_active` marks the window the account is actually constrained by, which
// beats inferring it from the highest percentage.
//
// The sibling flat map (five_hour/seven_day/…) is the fallback for payloads
// without `limits`; it also carries a long tail of codenamed placeholder
// windows that are always null, so null entries must be skipped rather than
// rendered.
// ---------------------------------------------------------------------------

function claudeUsageApiWindowLabels(
  kind: string,
  scopeLabel: string | null,
): { label: string; shortLabel: string } {
  if (scopeLabel !== null) {
    return { label: `Weekly (${scopeLabel})`, shortLabel: scopeLabel };
  }
  switch (kind) {
    case "session":
      return { label: "Session (5h)", shortLabel: "5h" };
    case "weekly_all":
      return { label: "Weekly (all models)", shortLabel: "Wk" };
    default:
      return claudeWindowLabels(kind);
  }
}

function claudeUsageApiBaseWindowId(kind: string, scopeLabel: string | null): string {
  // Use the passive event stream's established ids so interleaved pull/push
  // updates address the same semantic window instead of creating duplicates.
  if (kind === "session") return "five_hour";
  if (kind === "weekly_all") return "seven_day";
  if (kind.startsWith("weekly") && scopeLabel !== null) {
    const scopeId = scopeLabel
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (scopeId.length > 0) return `seven_day_${scopeId}`;
  }
  return kind;
}

/** ISO 8601 (usage API) → unix seconds, matching the event stream's units. */
function isoToUnixSeconds(value: unknown): number | null {
  const text = asString(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.round(parsed / 1_000) : null;
}

function normalizeClaudeUsageApiPayload(payload: Record<string, unknown>): {
  providerLabel: "Claude";
  windows: ProviderUsageWindow[];
  clearedWindowIds: string[];
  activeWindowId: string | null;
} | null {
  const rateLimits = asRecord(payload.rateLimits);
  if (!rateLimits) return null;

  const windows: ProviderUsageWindow[] = [];
  let activeWindowId: string | null = null;

  // An empty array must fall through to the flat map rather than claim the
  // payload reported no windows — the flat map is the SDK's declared shape and
  // may still be populated alongside an empty `limits`.
  const limits =
    Array.isArray(rateLimits.limits) && rateLimits.limits.length > 0 ? rateLimits.limits : null;
  if (limits) {
    const candidates: Array<{
      index: number;
      limit: Record<string, unknown>;
      kind: string;
      scopeLabel: string | null;
      scopeModelId: string | null;
      scopeSurface: string | null;
      baseId: string;
      percent: number;
    }> = [];
    for (const [index, entry] of limits.entries()) {
      const limit = asRecord(entry);
      if (!limit) continue;
      const percent = asFiniteNumber(limit.percent);
      if (percent === null) continue;
      const kind = asString(limit.kind) ?? "unknown";
      const scope = asRecord(limit.scope);
      const scopeModel = asRecord(scope?.model);
      const scopeLabel = asString(scopeModel?.display_name);
      candidates.push({
        index,
        limit,
        kind,
        scopeLabel,
        scopeModelId: asString(scopeModel?.id),
        scopeSurface: asString(scope?.surface),
        baseId: claudeUsageApiBaseWindowId(kind, scopeLabel),
        percent,
      });
    }

    const baseIdCounts = new Map<string, number>();
    for (const candidate of candidates) {
      baseIdCounts.set(candidate.baseId, (baseIdCounts.get(candidate.baseId) ?? 0) + 1);
    }
    const usedIds = new Set<string>();
    for (const candidate of candidates) {
      const { index, limit, kind, scopeLabel, baseId, percent } = candidate;
      const { label, shortLabel } = claudeUsageApiWindowLabels(kind, scopeLabel);
      // A display label normally identifies a scoped model and keeps parity
      // with passive ids. If the API repeats that identity, prefer stable scope
      // metadata and use the position only as the final defensive fallback.
      const repeatedBaseId = (baseIdCounts.get(baseId) ?? 0) > 1;
      const scopeIdentity =
        [candidate.scopeModelId, candidate.scopeSurface]
          .filter((value): value is string => value !== null)
          .join(":") || null;
      let id =
        repeatedBaseId && scopeIdentity !== null
          ? `${baseId}:${scopeIdentity}`
          : repeatedBaseId || kind === "unknown"
            ? `${baseId}:${index}`
            : baseId;
      if (usedIds.has(id)) id = `${id}:${index}`;
      usedIds.add(id);
      const usedPercent = clampPercent(percent);
      if (limit.is_active === true) {
        activeWindowId = id;
      }
      // The payload's own `group` ("session" / "weekly") is authoritative when
      // present; otherwise infer it from the window kind.
      const reportedGroup = asString(limit.group);
      windows.push({
        id,
        group:
          reportedGroup === "session" || reportedGroup === "weekly"
            ? reportedGroup
            : kind === "session"
              ? "session"
              : kind.startsWith("weekly")
                ? "weekly"
                : "other",
        label,
        shortLabel,
        usedPercent,
        resetsAt: isoToUnixSeconds(limit.resets_at),
        status: maxStatus(
          statusForPercent(usedPercent),
          asString(limit.severity) === "critical" ? "critical" : "ok",
        ),
        reportedStatus: asString(limit.severity) === "critical" ? "critical" : "ok",
      });
    }
  } else {
    // Fallback: the flat window map, skipping the always-null placeholders.
    for (const [key, value] of Object.entries(rateLimits)) {
      const window = asRecord(value);
      if (!window) continue;
      const utilization = asFiniteNumber(window.utilization);
      if (utilization === null) continue;
      const { label, shortLabel } = claudeWindowLabels(key);
      const usedPercent = clampPercent(utilization);
      windows.push({
        id: key,
        group: claudeWindowGroup(key),
        label,
        shortLabel,
        usedPercent,
        resetsAt: isoToUnixSeconds(window.resets_at),
        status: statusForPercent(usedPercent),
      });
    }
  }

  return {
    providerLabel: "Claude",
    windows,
    // The usage API reports every window at once, so it is authoritative:
    // windows it omits no longer exist and must not linger from older events.
    clearedWindowIds: [],
    activeWindowId,
  };
}

// ---------------------------------------------------------------------------
// Codex
//
// The app-server notification is `{ rateLimits: { limitId?, limitName?,
// primary?, secondary?, rateLimitReachedType?, ... } }`, and the adapter wraps
// the whole notification once more, so the activity payload can nest one or
// two levels deep. Windows are `{ usedPercent, windowDurationMins?, resetsAt? }`
// (camelCase, validated against the generated protocol schema server-side).
// The 5h window is often absent — only render windows actually reported.
// ---------------------------------------------------------------------------

/**
 * Codex reports a per-model-tier limit for the Spark tier as its own snapshot
 * (its own limitId/limitName). It cannot be disabled account-side and is noise
 * in this meter, so it is suppressed here — the single place to revisit if
 * that call changes. Matched loosely: the exact label varies by release.
 */
function codexLimitIdentity(snapshot: Record<string, unknown>): string | null {
  const identity = [asString(snapshot.limitId), asString(snapshot.limitName)]
    .filter((value): value is string => value !== null)
    .join(" ");
  return identity.length > 0 ? identity : null;
}

function isSuppressedCodexLimit(identity: string | null): boolean {
  return identity !== null && /spark/i.test(identity);
}

function codexWindowLabels(durationMins: number | null): {
  id: string;
  label: string;
  shortLabel: string;
} {
  if (durationMins === null) {
    return { id: "codex-window", label: "Usage", shortLabel: "Usage" };
  }
  if (durationMins < 24 * 60) {
    const hours = Math.round(durationMins / 60);
    return hours > 0
      ? { id: `codex-${durationMins}m`, label: `Session (${hours}h)`, shortLabel: `${hours}h` }
      : {
          id: `codex-${durationMins}m`,
          label: `Session (${durationMins} min)`,
          shortLabel: `${durationMins}m`,
        };
  }
  const days = Math.round(durationMins / (24 * 60));
  return days === 7
    ? { id: `codex-${durationMins}m`, label: "Weekly", shortLabel: "Wk" }
    : { id: `codex-${durationMins}m`, label: `${days}-day`, shortLabel: `${days}d` };
}

function normalizeCodexRateLimits(
  payload: Record<string, unknown>,
  inheritedIdentity: string | null,
): {
  providerLabel: "Codex";
  windows: ProviderUsageWindow[];
  limitIdentity: string | null;
  forceCritical: boolean;
  suppressed: boolean;
} {
  // Unwrap `{ rateLimits: ... }` nesting until a level with windows appears.
  let snapshot = payload;
  for (let depth = 0; depth < 2 && !snapshot.primary && !snapshot.secondary; depth += 1) {
    const nested = asRecord(snapshot.rateLimits);
    if (!nested) break;
    snapshot = nested;
  }

  const limitIdentity = codexLimitIdentity(snapshot) ?? inheritedIdentity;
  const suppressed = isSuppressedCodexLimit(limitIdentity);
  const exhausted = asString(snapshot.rateLimitReachedType) !== null;
  const windows: ProviderUsageWindow[] = [];
  const usedIds = new Set<string>();

  for (const slot of ["primary", "secondary"] as const) {
    const window = asRecord(snapshot[slot]);
    if (!window) continue;
    const usedPercentRaw = asFiniteNumber(window.usedPercent);
    if (usedPercentRaw === null) continue;
    const usedPercent = clampPercent(usedPercentRaw);
    const durationMins = asFiniteNumber(window.windowDurationMins);
    const { id: semanticId, label, shortLabel } = codexWindowLabels(durationMins);
    const baseId = durationMins === null ? `${slot}:${semanticId}` : semanticId;
    const id = usedIds.has(baseId) ? `${baseId}#${slot}` : baseId;
    usedIds.add(id);
    const group: ProviderUsageWindowGroup =
      durationMins === null ? "other" : durationMins < 24 * 60 ? "session" : "weekly";
    windows.push({
      group,
      id,
      label,
      shortLabel,
      usedPercent,
      resetsAt: asFiniteNumber(window.resetsAt),
      status: statusForPercent(usedPercent),
    });
  }

  return {
    providerLabel: "Codex",
    windows: suppressed ? [] : windows,
    limitIdentity,
    forceCritical: exhausted,
    suppressed,
  };
}

// ---------------------------------------------------------------------------
// Payload dispatch + snapshot derivation
// ---------------------------------------------------------------------------

type NormalizedRateLimitPayload =
  | {
      readonly providerLabel: "Claude";
      readonly windows: ProviderUsageWindow[];
      readonly clearedWindowIds: ReadonlyArray<string>;
      /** Usage-API payloads report every window at once and replace the merge state. */
      readonly authoritative?: boolean;
      /** Window the provider flags as currently binding, when it says so. */
      readonly activeWindowId?: string | null;
    }
  | {
      readonly providerLabel: "Codex";
      readonly windows: ProviderUsageWindow[];
      readonly limitIdentity: string | null;
      readonly forceCritical: boolean;
      readonly suppressed: boolean;
    };

function normalizeRateLimitPayload(
  payload: unknown,
  inheritedCodexIdentity: string | null,
): NormalizedRateLimitPayload | null {
  const record = asRecord(payload);
  if (!record) return null;

  // Two shapes reach here: a server-owned refresh snapshot, which IS the
  // provider payload, and a thread activity, which wraps that same payload in
  // `{ rateLimits: <provider event> }`. A payload that names its own `source`
  // is already unwrapped — unwrapping it again would hand the Claude branch
  // the inner `rate_limits` object and normalize to null. Codex refresh
  // payloads carry no top-level `source`, so they still unwrap as before.
  const event = asString(record.source) !== null ? record : (asRecord(record.rateLimits) ?? record);

  // Checked before the Codex branch: the usage-API payload also nests a
  // `rateLimits` key and would otherwise be misread as a Codex snapshot.
  if (asString(event.source) === "claude.usage-api") {
    const normalized = normalizeClaudeUsageApiPayload(event);
    return normalized ? { ...normalized, authoritative: true } : null;
  }
  if (event.rate_limit_info || event.type === "rate_limit_event") {
    const normalized = normalizeClaudeRateLimitEvent(event);
    return normalized ? { ...normalized, providerLabel: "Claude" } : null;
  }
  if (
    event.primary ||
    event.secondary ||
    event.rateLimits ||
    asString(event.rateLimitReachedType) !== null
  ) {
    return normalizeCodexRateLimits(event, inheritedCodexIdentity);
  }
  if (
    asString(event.rateLimitType) !== null ||
    asString(event.rate_limit_type) !== null ||
    asFiniteNumber(event.utilization) !== null
  ) {
    const normalized = normalizeClaudeRateLimitEvent(event);
    return normalized ? { ...normalized, providerLabel: "Claude" } : null;
  }
  return null;
}

/** Maps a provider driver kind to the meter's provider label; null renders nothing. */
export function providerUsageLabelForDriver(driver: string | null | undefined): string | null {
  switch (driver) {
    case "claude":
    case "claudeAgent":
      return "Claude";
    case "codex":
      return "Codex";
    default:
      // Only providers with machine-readable quota get a meter; a fabricated
      // percentage would be worse than no meter.
      return null;
  }
}

export type DeriveProviderUsageOptions = {
  /** Driver kind of the thread's provider; limits which events are considered. */
  readonly provider?: string | null;
  /** Provider account/instance of the thread; prevents same-driver account mixing. */
  readonly providerInstanceId?: string | null;
  /** Reference time for staleness and reset-expiry checks. */
  readonly now?: number;
  /** Warning/critical percentages; defaults to 80/95 when omitted. */
  readonly thresholds?: Partial<ProviderUsageThresholds> | undefined;
};

export function resolveProviderUsageInstanceId<TInstanceId extends string>(input: {
  readonly liveSessionInstanceId?: TInstanceId | null | undefined;
  readonly modelSelectionInstanceId?: TInstanceId | null | undefined;
}): TInstanceId | null {
  return input.liveSessionInstanceId ?? input.modelSelectionInstanceId ?? null;
}

export function resolveProviderUsageModel(input: {
  readonly liveSessionInstanceId?: string | null | undefined;
  readonly persistedModel?: string | null | undefined;
  readonly selectedModel: string;
}): string {
  return input.liveSessionInstanceId === null || input.liveSessionInstanceId === undefined
    ? input.selectedModel
    : (input.persistedModel ?? input.selectedModel);
}

type ProviderUsagePayloadSource = {
  readonly payload: unknown;
  readonly createdAt: string;
};

/**
 * Normalize one server-owned per-instance usage snapshot. The caller supplies
 * the instance's driver via `options.provider` (it already has it from the
 * provider list).
 *
 * A gateway snapshot (`cliproxyapi.management`) carries a pool of upstream
 * accounts rather than one; here it collapses to the featured account so
 * single-account surfaces (the ring, alerts) keep working — the full pool is
 * available through `deriveProviderUsageAccountsFromServerSnapshot`. Pass
 * `preferredUpstreamProvider` when the caller knows which upstream serves the
 * thread; see `featuredProviderUsageAccount`.
 */
export function deriveProviderUsageSnapshotFromServerSnapshot(
  snapshot: Pick<ProviderInstanceUsageSnapshot, "instanceId" | "payload" | "observedAt">,
  options: Omit<DeriveProviderUsageOptions, "providerInstanceId"> & {
    readonly preferredUpstreamProvider?: string | null;
  } = {},
): ProviderUsageSnapshot | null {
  const accounts = deriveProviderUsageAccountsFromServerSnapshot(snapshot, options);
  if (accounts !== null) {
    return (
      featuredProviderUsageAccount(
        accounts.accounts,
        options.preferredUpstreamProvider === undefined
          ? "claude"
          : options.preferredUpstreamProvider,
      )?.usage ?? null
    );
  }
  return deriveProviderUsageSnapshotFromSources(
    [
      {
        payload: snapshot.payload,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(snapshot.observedAt)),
      },
    ],
    {
      ...options,
      providerInstanceId: snapshot.instanceId,
    },
  );
}

// ---------------------------------------------------------------------------
// CLIProxyAPI gateway pools
//
// A provider instance backed by a CLIProxyAPI gateway reports one snapshot
// carrying every pooled upstream account: `{ source: "cliproxyapi.management",
// accounts: [{ id, label, provider, priority, state, planType?, usage,
// error? }] }`. Each account's `usage` arrives in the matching direct
// provider's payload shape, so per-account normalization reuses the dispatch
// above verbatim.
// ---------------------------------------------------------------------------

export const CLIPROXYAPI_USAGE_PAYLOAD_SOURCE = "cliproxyapi.management";

export function resolveProviderUsageUpstreamProvider(input: {
  readonly payload: unknown;
  readonly model: string;
  readonly isCustom: boolean;
}): string | null {
  const mapped = asString(asRecord(asRecord(input.payload)?.modelProviders)?.[input.model]);
  return mapped ?? (input.isCustom ? null : "claude");
}

export type ProviderUsageAccountState = "available" | "disabled" | "cooldown";

export type ProviderUsageAccount = {
  /** Stable identity within the pool (the gateway's auth-file name). */
  readonly id: string;
  readonly label: string;
  /** Upstream provider slug as the gateway reports it ("claude", "codex"). */
  readonly provider: string;
  /** Failover-ladder tier; higher serves first. Null when unreported. */
  readonly priority: number | null;
  readonly state: ProviderUsageAccountState;
  /** Plan tier when the upstream reports one (Codex only today). */
  readonly planType: string | null;
  /** Why this account's usage is missing, when the gateway said so. */
  readonly error: string | null;
  readonly usage: ProviderUsageSnapshot | null;
};

export type ProviderUsageAccountsSnapshot = {
  readonly providerInstanceId: string;
  readonly accounts: ReadonlyArray<ProviderUsageAccount>;
  readonly updatedAt: string;
};

function asAccountState(value: unknown): ProviderUsageAccountState {
  return value === "disabled" || value === "cooldown" ? value : "available";
}

/**
 * Normalize a gateway pool snapshot into per-account usage. Returns null for
 * snapshots from any other source, which is how callers detect that an
 * instance is gateway-backed in the first place.
 */
export function deriveProviderUsageAccountsFromServerSnapshot(
  snapshot: Pick<ProviderInstanceUsageSnapshot, "instanceId" | "payload" | "observedAt">,
  options: Omit<DeriveProviderUsageOptions, "providerInstanceId" | "provider"> = {},
): ProviderUsageAccountsSnapshot | null {
  const payload = asRecord(snapshot.payload);
  if (asString(payload?.source) !== CLIPROXYAPI_USAGE_PAYLOAD_SOURCE) return null;
  const rawAccounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  const observedAtIso = DateTime.formatIso(DateTime.makeUnsafe(snapshot.observedAt));

  const accounts: ProviderUsageAccount[] = [];
  for (const [index, value] of rawAccounts.entries()) {
    const account = asRecord(value);
    if (!account) continue;
    accounts.push({
      id: asString(account.id) ?? `account-${index}`,
      label: asString(account.label) ?? `Account ${index + 1}`,
      provider: asString(account.provider) ?? "unknown",
      priority: asFiniteNumber(account.priority),
      state: asAccountState(account.state),
      planType: asString(account.planType),
      error: asString(account.error),
      // No driver filter (deliberately not spreading caller options): a
      // Claude-driver gateway instance legitimately pools Codex accounts for
      // its custom models.
      usage: deriveProviderUsageSnapshotFromSources(
        [{ payload: account.usage, createdAt: observedAtIso }],
        {
          ...(options.now !== undefined ? { now: options.now } : {}),
          ...(options.thresholds !== undefined ? { thresholds: options.thresholds } : {}),
          providerInstanceId: snapshot.instanceId,
        },
      ),
    });
  }
  if (accounts.length === 0) return null;

  return {
    providerInstanceId: snapshot.instanceId,
    accounts,
    updatedAt: observedAtIso,
  };
}

const byProviderUsageAccountPriority = (a: ProviderUsageAccount, b: ProviderUsageAccount) =>
  (b.priority ?? Number.NEGATIVE_INFINITY) - (a.priority ?? Number.NEGATIVE_INFINITY);

/** Highest priority first — the order the gateway's failover ladder serves. */
export function sortProviderUsageAccountsByPriority(
  accounts: ReadonlyArray<ProviderUsageAccount>,
): ReadonlyArray<ProviderUsageAccount> {
  // Hermes lacks ES2023 change-by-copy methods, so copy before sorting.
  return [...accounts].sort(byProviderUsageAccountPriority);
}

/**
 * The pooled account a compact single-account surface (ring, alerts) should
 * represent: the highest-priority account of `preferredUpstreamProvider` that
 * the gateway can still serve — the one the next turn will actually spend.
 *
 * Two deliberate choices:
 *   - An account whose own usage read failed is still featured. Substituting a
 *     sibling's percentage would misreport the account being spent; the
 *     popover shows that account's error instead.
 *   - When every matching account is cooling down, the highest-priority
 *     cooled-down one is featured rather than nothing: a fully exhausted pool
 *     is exactly when the meter must be loudest, and returning null there
 *     would make it go dark instead of red.
 *
 * `preferredUpstreamProvider` of null means the caller cannot tell which
 * upstream serves this thread (e.g. a custom model on a mixed pool); feature
 * nothing rather than a quota the turn will not spend.
 */
export function featuredProviderUsageAccount(
  accounts: ReadonlyArray<ProviderUsageAccount>,
  preferredUpstreamProvider: string | null = "claude",
): ProviderUsageAccount | null {
  if (preferredUpstreamProvider === null) return null;
  const ofProvider = accounts.filter((account) => account.provider === preferredUpstreamProvider);
  const available = ofProvider.filter((account) => account.state === "available");
  return (
    sortProviderUsageAccountsByPriority(available.length > 0 ? available : ofProvider)[0] ?? null
  );
}

/**
 * Presentation fields shared by every surface that renders a pooled gateway
 * account, so the two composers cannot drift apart on labelling.
 */
export function presentProviderUsageAccount(account: ProviderUsageAccount): {
  readonly displayName: string;
  readonly email: string | undefined;
  readonly detail: string | null;
} {
  // Gateway account labels are often the upstream login email; route those
  // through the email slot so the masking preference applies.
  const emailLikeLabel = account.label.includes("@");
  return {
    displayName: emailLikeLabel ? account.id : account.label,
    email: emailLikeLabel ? account.label : undefined,
    detail:
      [
        account.priority !== null ? `tier ${account.priority}` : null,
        account.state !== "available" ? account.state : null,
        account.planType,
        account.usage === null ? account.error : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
  };
}

/**
 * Derives the latest usage snapshot from a thread's activity stream.
 *
 * Claude emits one event per window, so the most recent event for each window
 * id is merged into a single snapshot; Codex reports all windows in one event.
 * Windows whose reset time has already passed are dropped rather than shown
 * with a pre-reset percentage.
 */
export function deriveLatestProviderUsageSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options: DeriveProviderUsageOptions = {},
): ProviderUsageSnapshot | null {
  return deriveProviderUsageSnapshotFromSources(
    activities.flatMap((activity) =>
      activity?.kind === "account.rate-limits.updated"
        ? [{ payload: activity.payload, createdAt: activity.createdAt }]
        : [],
    ),
    options,
  );
}

function deriveProviderUsageSnapshotFromSources(
  sources: ReadonlyArray<ProviderUsagePayloadSource>,
  options: DeriveProviderUsageOptions,
): ProviderUsageSnapshot | null {
  const requestedLabel =
    options.provider !== undefined ? providerUsageLabelForDriver(options.provider) : undefined;
  if (requestedLabel === null) {
    return null;
  }

  type MergedWindow = {
    readonly window: ProviderUsageWindow;
    readonly sourceAt: string;
    readonly forcedCriticalAt: string | null;
  };

  const windowsById = new Map<string, MergedWindow>();
  const requestedInstanceId = asString(options.providerInstanceId);
  let providerLabel: string | null = null;
  let providerInstanceId: string | null = requestedInstanceId;
  let inheritedCodexIdentity: string | null = null;
  let activeWindowId: string | null = null;

  const resetMergeState = (nextProviderLabel: string, nextProviderInstanceId: string | null) => {
    windowsById.clear();
    providerLabel = nextProviderLabel;
    providerInstanceId = requestedInstanceId ?? nextProviderInstanceId;
    inheritedCodexIdentity = null;
    activeWindowId = null;
  };

  // Oldest first: Map#set gives newest-wins semantics per semantic window id
  // while retaining Codex identity across sparse rolling updates.
  for (const source of sources) {
    const payloadRecord = asRecord(source.payload);
    const sourceInstanceId = asString(payloadRecord?.providerInstanceId);
    if (
      requestedInstanceId !== null &&
      sourceInstanceId !== null &&
      sourceInstanceId !== requestedInstanceId
    ) {
      continue;
    }

    const instanceChanged =
      requestedInstanceId === null &&
      sourceInstanceId !== null &&
      providerInstanceId !== sourceInstanceId;
    const result = normalizeRateLimitPayload(
      source.payload,
      instanceChanged ? null : inheritedCodexIdentity,
    );
    if (!result) continue;
    if (requestedLabel !== undefined && result.providerLabel !== requestedLabel) continue;

    if (providerLabel !== result.providerLabel || instanceChanged) {
      resetMergeState(result.providerLabel, sourceInstanceId);
    }

    if (result.providerLabel === "Codex") {
      inheritedCodexIdentity = result.limitIdentity;
      if (result.suppressed) {
        continue;
      }
    } else if (result.authoritative === true) {
      // A full quota report supersedes everything merged so far, including
      // windows the account no longer has.
      windowsById.clear();
      activeWindowId = result.activeWindowId ?? null;
    } else {
      for (const windowId of result.clearedWindowIds) {
        windowsById.delete(windowId);
      }
      // A single-window event cannot confirm which window is binding overall;
      // keep the last authoritative answer only while that window survives.
      if (activeWindowId !== null && result.windows.some((w) => w.id === activeWindowId)) {
        activeWindowId = null;
      }
    }

    for (const window of result.windows) {
      const previous = windowsById.get(window.id);
      const sameResetPeriod =
        previous !== undefined &&
        (previous.window.resetsAt === null ||
          window.resetsAt === null ||
          previous.window.resetsAt === window.resetsAt);
      const forcedCriticalAt =
        result.providerLabel === "Codex" && result.forceCritical
          ? source.createdAt
          : sameResetPeriod
            ? (previous?.forcedCriticalAt ?? null)
            : null;
      windowsById.delete(window.id);
      windowsById.set(window.id, {
        window,
        sourceAt: source.createdAt,
        forcedCriticalAt,
      });
    }

    if (result.providerLabel === "Codex" && result.forceCritical) {
      for (const [id, merged] of windowsById) {
        windowsById.set(id, {
          window: merged.window,
          sourceAt: source.createdAt,
          forcedCriticalAt: source.createdAt,
        });
      }
    }
  }

  if (providerLabel === null) {
    return null;
  }

  const nowMs = options.now;
  const mergedWindows = Array.from(windowsById.values())
    .filter(({ window, sourceAt }) => {
      if (nowMs === undefined) return true;
      if (window.resetsAt !== null && window.resetsAt * 1_000 <= nowMs) return false;
      const sourceAtMs = Date.parse(sourceAt);
      return !Number.isFinite(sourceAtMs) || nowMs - sourceAtMs < PROVIDER_USAGE_MAX_AGE_MS;
    })
    // Hermes does not ship ES2023 change-by-copy methods; Array.from already
    // gave us a safe copy to mutate here.
    .sort((a, b) => {
      const aMs = Date.parse(a.sourceAt);
      const bMs = Date.parse(b.sourceAt);
      if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return 0;
      return bMs - aMs;
    });
  if (mergedWindows.length === 0) {
    return null;
  }

  const windows = mergedWindows.map(({ window, forcedCriticalAt }) => {
    if (forcedCriticalAt === null) return window;
    const forcedCriticalAtMs = Date.parse(forcedCriticalAt);
    const forcedCriticalIsFresh =
      nowMs === undefined ||
      !Number.isFinite(forcedCriticalAtMs) ||
      nowMs - forcedCriticalAtMs < PROVIDER_USAGE_MAX_AGE_MS;
    // `reportedStatus` too: the provider said the limit is spent, so no
    // threshold change may ever soften this window back to a warning.
    return forcedCriticalIsFresh
      ? {
          ...window,
          status: maxStatus(window.status, "critical"),
          reportedStatus: maxStatus(window.reportedStatus ?? "ok", "critical"),
        }
      : window;
  });
  let updatedAt = mergedWindows[0]?.sourceAt;
  let updatedAtMs = Number.NEGATIVE_INFINITY;
  for (const { sourceAt } of mergedWindows) {
    const sourceAtMs = Date.parse(sourceAt);
    if (Number.isFinite(sourceAtMs) && sourceAtMs > updatedAtMs) {
      updatedAt = sourceAt;
      updatedAtMs = sourceAtMs;
    }
  }
  if (!updatedAt) return null;

  const { status, constrainedWindow } = summarizeProviderUsageWindows(windows, activeWindowId);

  return applyProviderUsageThresholds(
    {
      providerLabel,
      providerInstanceId,
      windows,
      status,
      constrainedWindow,
      updatedAt,
      activeWindowId,
    },
    options.thresholds,
  );
}

/**
 * Snapshot-level severity and the window a compact surface should feature.
 *
 * The provider's own "active" flag beats inferring the binding window from
 * percentages — a 44% Fable weekly can bind while a 24% all-models weekly does
 * not. It may NOT downgrade severity though: compact surfaces render this
 * window alone, so preferring an active warning over a critical window
 * elsewhere would hide the very state the meter exists to surface.
 */
function summarizeProviderUsageWindows(
  windows: ReadonlyArray<ProviderUsageWindow>,
  activeWindowId: string | null | undefined,
): {
  readonly status: ProviderUsageStatus;
  readonly constrainedWindow: ProviderUsageWindow | null;
} {
  const status = windows.reduce<ProviderUsageStatus>(
    (acc, window) => maxStatus(acc, window.status),
    "ok",
  );
  const flaggedActiveWindow =
    activeWindowId !== null && activeWindowId !== undefined
      ? (windows.find((w) => w.id === activeWindowId) ?? null)
      : null;
  const constrainedWindow =
    status === "ok" || windows.length === 0
      ? null
      : flaggedActiveWindow !== null && flaggedActiveWindow.status === status
        ? flaggedActiveWindow
        : windows.reduce((worst, window) => {
            const severityDelta = statusRank(window.status) - statusRank(worst.status);
            if (severityDelta !== 0) return severityDelta > 0 ? window : worst;
            return (window.usedPercent ?? 0) > (worst.usedPercent ?? 0) ? window : worst;
          });
  return { status, constrainedWindow };
}

/**
 * Re-evaluates a snapshot's severities against different warning/critical
 * thresholds. Percentage-derived severity is recomputed; a severity the
 * provider itself reported is a floor and survives untouched, as does the
 * severity of a window that carries a state but no percentage.
 *
 * Lets a surface honour user thresholds without re-deriving from activities.
 */
export function applyProviderUsageThresholds(
  snapshot: ProviderUsageSnapshot,
  thresholds: Partial<ProviderUsageThresholds> | undefined,
): ProviderUsageSnapshot;
export function applyProviderUsageThresholds(
  snapshot: ProviderUsageSnapshot | null,
  thresholds: Partial<ProviderUsageThresholds> | undefined,
): ProviderUsageSnapshot | null;
export function applyProviderUsageThresholds(
  snapshot: ProviderUsageSnapshot | null,
  thresholds: Partial<ProviderUsageThresholds> | undefined,
): ProviderUsageSnapshot | null {
  if (snapshot === null) return null;
  const resolved = normalizeProviderUsageThresholds(thresholds);
  const windows = snapshot.windows.map((window) => {
    if (window.usedPercent === null) {
      // No number to threshold against; whatever state the provider signalled
      // is all this window has ever had.
      return window;
    }
    const status = maxStatus(
      statusForPercent(window.usedPercent, resolved),
      window.reportedStatus ?? "ok",
    );
    return status === window.status ? window : { ...window, status };
  });
  const { status, constrainedWindow } = summarizeProviderUsageWindows(
    windows,
    snapshot.activeWindowId,
  );
  return { ...snapshot, windows, status, constrainedWindow };
}

/**
 * The single window a compact surface (a ring, a pill) should represent.
 *
 * Prefers the session window and falls back to the weekly one — the session
 * window is the actionable near-term constraint, and it is often absent
 * (Codex reports weekly only today). A window in warning or critical state
 * always wins regardless of class: a calm 3% session window must never mask
 * a Fable weekly window sitting at 96%.
 */
export function primaryProviderUsageWindow(
  snapshot: ProviderUsageSnapshot,
): ProviderUsageWindow | null {
  if (snapshot.windows.length === 0) return null;
  if (snapshot.constrainedWindow !== null) return snapshot.constrainedWindow;
  return (
    snapshot.windows.find((window) => window.group === "session") ??
    snapshot.windows.find((window) => window.group === "weekly") ??
    snapshot.windows[0] ??
    null
  );
}

// ---------------------------------------------------------------------------
// Threshold alerts
// ---------------------------------------------------------------------------

export type ProviderUsageAlert = {
  /** All de-dupe keys this alert covers; callers must persist every one. */
  readonly keys: ReadonlyArray<string>;
  readonly providerLabel: string;
  readonly window: ProviderUsageWindow;
  readonly threshold: "warning" | "critical";
};

/**
 * Computes which threshold notifications the snapshot warrants, de-duplicated
 * against `firedKeys`. Keys embed the window's reset time, so each threshold
 * fires at most once per window per known reset period; callers choose a
 * bounded fallback for windows whose reset time is unavailable and persist
 * every key in `alert.keys`. When usage jumps straight past both thresholds a
 * single critical alert is surfaced, with the warning key marked alongside.
 */
export function collectProviderUsageAlerts(
  snapshot: ProviderUsageSnapshot | null,
  firedKeys: ReadonlySet<string>,
  alertScope?: string | null,
): ProviderUsageAlert[] {
  if (!snapshot) return [];

  const alerts: ProviderUsageAlert[] = [];
  for (const window of snapshot.windows) {
    if (window.status === "ok") continue;
    const crossed: Array<"warning" | "critical"> =
      window.status === "critical" ? ["warning", "critical"] : ["warning"];
    const keys = crossed.map((threshold) =>
      providerUsageAlertKey(
        snapshot.providerLabel,
        window,
        threshold,
        snapshot.providerInstanceId,
        alertScope,
      ),
    );
    const freshKeys = keys.filter((key) => !firedKeys.has(key));
    if (freshKeys.length === 0) continue;
    // The most severe crossed threshold must itself be fresh — otherwise the
    // critical alert already fired and a late warning would only be noise.
    if (firedKeys.has(keys[keys.length - 1] ?? "")) continue;
    alerts.push({
      keys: freshKeys,
      providerLabel: snapshot.providerLabel,
      window,
      threshold: crossed[crossed.length - 1] ?? "warning",
    });
  }
  return alerts;
}

export function providerUsageAlertKey(
  providerLabel: string,
  window: ProviderUsageWindow,
  threshold: "warning" | "critical",
  providerInstanceId?: string | null,
  alertScope?: string | null,
): string {
  const providerScope = providerInstanceId
    ? `${providerLabel}@${providerInstanceId}`
    : providerLabel;
  const scope = alertScope ? `${alertScope}:${providerScope}` : providerScope;
  return `${scope}:${window.id}:${threshold}:${window.resetsAt ?? "unknown"}`;
}
