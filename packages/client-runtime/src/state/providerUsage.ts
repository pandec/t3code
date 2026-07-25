import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/**
 * Subscription rate-limit usage derived from `account.rate-limits.updated`
 * thread activities. Providers report usage in undocumented, provider-specific
 * shapes that have already drifted between CLI releases, so everything here is
 * defensive: unknown window taxonomies fall back to readable labels instead of
 * being dropped, and payloads that carry no usable data yield no snapshot —
 * a percentage is never fabricated.
 */

/** Windows at or above this usage render as a warning. */
export const PROVIDER_USAGE_WARNING_PERCENT = 80;
/** Windows at or above this usage render as critical. */
export const PROVIDER_USAGE_CRITICAL_PERCENT = 95;

/** A snapshot older than this no longer reflects reality; render nothing. */
const PROVIDER_USAGE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export type ProviderUsageStatus = "ok" | "warning" | "critical";

export type ProviderUsageWindow = {
  /** Stable identity for merging events and de-duping alerts, e.g. "five_hour". */
  readonly id: string;
  /** Popover row label, e.g. "Session (5h)" or "Weekly (Fable)". */
  readonly label: string;
  /** Compact label for the inline trigger, e.g. "5h" or "Wk". */
  readonly shortLabel: string;
  /** 0-100, or null when the provider signalled state without a number. */
  readonly usedPercent: number | null;
  /** Unix seconds when this window resets, or null if unknown. */
  readonly resetsAt: number | null;
  readonly status: ProviderUsageStatus;
};

export type ProviderUsageSnapshot = {
  readonly providerLabel: string;
  readonly windows: ReadonlyArray<ProviderUsageWindow>;
  readonly status: ProviderUsageStatus;
  /** The most constrained window; what the collapsed trigger surfaces. */
  readonly constrainedWindow: ProviderUsageWindow | null;
  readonly updatedAt: string;
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

function statusForPercent(percent: number | null): ProviderUsageStatus {
  if (percent === null) return "ok";
  if (percent >= PROVIDER_USAGE_CRITICAL_PERCENT) return "critical";
  if (percent >= PROVIDER_USAGE_WARNING_PERCENT) return "warning";
  return "ok";
}

function maxStatus(a: ProviderUsageStatus, b: ProviderUsageStatus): ProviderUsageStatus {
  const order: Record<ProviderUsageStatus, number> = { ok: 0, warning: 1, critical: 2 };
  return order[b] > order[a] ? b : a;
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
//       surpassedThreshold?: number,   // 0-1; sometimes sent instead
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
  providerLabel: string;
  windows: ProviderUsageWindow[];
} | null {
  const info = asRecord(payload.rate_limit_info) ?? payload;

  // Tolerate both camelCase (current SDK) and snake_case (older releases).
  const rateLimitType = asString(info.rateLimitType) ?? asString(info.rate_limit_type) ?? "unknown";
  const status = asString(info.status);
  const resetsAt = asFiniteNumber(info.resetsAt) ?? asFiniteNumber(info.resets_at);
  const utilization = asFiniteNumber(info.utilization) ?? asFiniteNumber(info.surpassedThreshold);

  let usedPercent = utilization !== null ? normalizeRatioOrPercent(utilization) : null;
  if (usedPercent === null && status === "rejected") {
    usedPercent = 100;
  }

  // "allowed" with no number carries no information worth rendering; a
  // non-allowed status without a number still deserves a (numberless) row.
  if (usedPercent === null && (status === null || status === "allowed")) {
    return null;
  }

  const { label, shortLabel } = claudeWindowLabels(rateLimitType);
  const windowStatus = maxStatus(
    statusForPercent(usedPercent),
    status === "rejected" ? "critical" : status === "allowed_warning" ? "warning" : "ok",
  );

  return {
    providerLabel: "Claude",
    windows: [
      { id: rateLimitType, label, shortLabel, usedPercent, resetsAt, status: windowStatus },
    ],
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
function isSuppressedCodexLimit(snapshot: Record<string, unknown>): boolean {
  const identity = `${asString(snapshot.limitId) ?? ""} ${asString(snapshot.limitName) ?? ""}`;
  return /spark/i.test(identity);
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

function normalizeCodexRateLimits(payload: Record<string, unknown>): {
  providerLabel: string;
  windows: ProviderUsageWindow[];
} | null {
  // Unwrap `{ rateLimits: ... }` nesting until a level with windows appears.
  let snapshot = payload;
  for (let depth = 0; depth < 2 && !snapshot.primary && !snapshot.secondary; depth += 1) {
    const nested = asRecord(snapshot.rateLimits);
    if (!nested) break;
    snapshot = nested;
  }

  if (isSuppressedCodexLimit(snapshot)) {
    return null;
  }

  const rejected = asString(snapshot.rateLimitReachedType) === "rate_limit_reached";
  const windows: ProviderUsageWindow[] = [];

  for (const slot of ["primary", "secondary"] as const) {
    const window = asRecord(snapshot[slot]);
    if (!window) continue;
    const usedPercentRaw = asFiniteNumber(window.usedPercent);
    if (usedPercentRaw === null) continue;
    const usedPercent = clampPercent(usedPercentRaw);
    const { id, label, shortLabel } = codexWindowLabels(asFiniteNumber(window.windowDurationMins));
    windows.push({
      id: `${slot}:${id}`,
      label,
      shortLabel,
      usedPercent,
      resetsAt: asFiniteNumber(window.resetsAt),
      status: maxStatus(statusForPercent(usedPercent), rejected ? "critical" : "ok"),
    });
  }

  if (windows.length === 0) {
    return null;
  }

  return { providerLabel: "Codex", windows };
}

// ---------------------------------------------------------------------------
// Payload dispatch + snapshot derivation
// ---------------------------------------------------------------------------

function normalizeRateLimitPayload(payload: unknown): {
  providerLabel: string;
  windows: ProviderUsageWindow[];
} | null {
  const record = asRecord(payload);
  if (!record) return null;

  // The activity payload is `{ rateLimits: <provider event> }` (see the
  // ingestion layer); tolerate the unwrapped shape too.
  const event = asRecord(record.rateLimits) ?? record;

  if (event.rate_limit_info || event.type === "rate_limit_event") {
    return normalizeClaudeRateLimitEvent(event);
  }
  if (event.primary || event.secondary || event.rateLimits) {
    return normalizeCodexRateLimits(event);
  }
  if (
    asString(event.rateLimitType) !== null ||
    asString(event.rate_limit_type) !== null ||
    asFiniteNumber(event.utilization) !== null
  ) {
    return normalizeClaudeRateLimitEvent(event);
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
  /** Reference time for staleness and reset-expiry checks. */
  readonly now?: number;
};

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
  const requestedLabel =
    options.provider !== undefined ? providerUsageLabelForDriver(options.provider) : undefined;
  if (requestedLabel === null) {
    return null;
  }

  const windowsById = new Map<string, ProviderUsageWindow>();
  let providerLabel: string | null = null;
  let updatedAt: string | null = null;

  // Newest first: the first event seen for each window id wins.
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "account.rate-limits.updated") continue;

    const result = normalizeRateLimitPayload(activity.payload);
    if (!result) continue;
    if (requestedLabel !== undefined && result.providerLabel !== requestedLabel) continue;

    if (providerLabel === null) {
      providerLabel = result.providerLabel;
      updatedAt = activity.createdAt;
    }
    if (result.providerLabel !== providerLabel) continue;

    for (const window of result.windows) {
      if (!windowsById.has(window.id)) {
        windowsById.set(window.id, window);
      }
    }
  }

  if (providerLabel === null || updatedAt === null) {
    return null;
  }

  const nowMs = options.now;
  if (nowMs !== undefined) {
    const updatedAtMs = Date.parse(updatedAt);
    if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs >= PROVIDER_USAGE_MAX_AGE_MS) {
      return null;
    }
  }

  const windows = Array.from(windowsById.values()).filter(
    (window) => nowMs === undefined || window.resetsAt === null || window.resetsAt * 1_000 > nowMs,
  );
  if (windows.length === 0) {
    return null;
  }

  const status = windows.reduce<ProviderUsageStatus>(
    (acc, window) => maxStatus(acc, window.status),
    "ok",
  );
  const constrainedWindow =
    status === "ok"
      ? null
      : windows.reduce((worst, window) =>
          (window.usedPercent ?? 0) > (worst.usedPercent ?? 0) ? window : worst,
        );

  return { providerLabel, windows, status, constrainedWindow, updatedAt };
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
 * fires at most once per window per reset period; callers persist every key in
 * `alert.keys` for the session. When usage jumps straight past both thresholds
 * a single critical alert is surfaced, with the warning key marked alongside.
 */
export function collectProviderUsageAlerts(
  snapshot: ProviderUsageSnapshot | null,
  firedKeys: ReadonlySet<string>,
): ProviderUsageAlert[] {
  if (!snapshot) return [];

  const alerts: ProviderUsageAlert[] = [];
  for (const window of snapshot.windows) {
    if (window.status === "ok") continue;
    const crossed: Array<"warning" | "critical"> =
      window.status === "critical" ? ["warning", "critical"] : ["warning"];
    const keys = crossed.map((threshold) =>
      providerUsageAlertKey(snapshot.providerLabel, window, threshold),
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
): string {
  return `${providerLabel}:${window.id}:${threshold}:${window.resetsAt ?? "unknown"}`;
}
