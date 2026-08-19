import type { ProviderUsageWindow } from "./providerUsage.js";

/**
 * Formatting shared by every surface that renders provider quota: the web
 * composer meter popover and the mobile usage sheet. Both show the same facts
 * (percent, reset time, snapshot freshness), so they must phrase them the same
 * way — the strings previously drifted because each client formatted its own.
 */

/** A snapshot older than this is dimmed as stale rather than trusted. */
export const PROVIDER_USAGE_STALE_AFTER_MS = 5 * 60_000;

/** Opening a usage surface re-reads anything older than this. */
export const PROVIDER_USAGE_REFRESH_ON_OPEN_AFTER_MS = 60_000;

/**
 * Minimum gap between gateway thread-account probes for one thread+model.
 * Deliberately wider than the pool-refresh debounce: the server-side probe
 * refreshes the gateway binding's sliding TTL, and the web popover opens on
 * hover, so a tight cadence would keep an idle session pinned to its account
 * just from the cursor grazing the meter.
 */
export const PROVIDER_USAGE_THREAD_ACCOUNT_PROBE_AFTER_MS = 60_000;

/** The last thread-account probe a usage surface issued; key is thread+model. */
export interface ProviderUsageThreadAccountProbe {
  readonly key: string;
  readonly askedAtMs: number;
}

/**
 * Whether a thread-account probe may go out now. A changed key (another
 * thread or model) always re-asks; the same key waits out the cadence cap.
 * An explicit ask (the refresh button) outranks the hover cadence but not
 * the spam floor — the probe renews the gateway's session-affinity TTL on
 * every call, so button-mashing must not turn into a request per click.
 */
export function shouldProbeProviderUsageThreadAccount(
  last: ProviderUsageThreadAccountProbe,
  key: string,
  nowMs: number,
  force = false,
): boolean {
  if (last.key !== key) return true;
  const elapsed = nowMs - last.askedAtMs;
  return elapsed >= (force ? 5_000 : PROVIDER_USAGE_THREAD_ACCOUNT_PROBE_AFTER_MS);
}

/** A probe answer, kept only with the context it was asked for. */
export interface ProviderUsageThreadAccountState {
  readonly threadId: string;
  readonly model: string;
  readonly authIndex: string;
}

/**
 * The bound account's auth index, but only when the stored answer was probed
 * for exactly this thread and model — the gateway keys bindings per
 * (session, model), so an answer for any other context says nothing here.
 */
export function resolveProviderUsageBoundAuthIndex(
  state: ProviderUsageThreadAccountState | null,
  threadId: string | undefined,
  model: string,
): string | null {
  if (state === null || threadId === undefined) return null;
  return state.threadId === threadId && state.model === model ? state.authIndex : null;
}

// Constructing an Intl formatter is expensive and these run once per window
// per account per render, so both shapes are built once at module scope.
const RESET_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const RESET_TIME_WITH_WEEKDAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Percentages read as whole numbers except near zero, where "0%" would hide the
 * difference between untouched and barely-touched quota.
 */
export function formatProviderUsagePercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

/**
 * Clock time for a reset that is still ahead, with a weekday once it is more
 * than a day out. A reset already in the past is stale information and reads as
 * nothing at all.
 */
export function formatProviderUsageResetTime(
  resetsAt: number | null,
  nowMs: number,
): string | null {
  if (resetsAt === null) return null;
  const resetMs = resetsAt * 1_000;
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
  const withinDay = resetMs - nowMs < 24 * 60 * 60 * 1_000;
  // Formatted straight from the epoch value: this package keeps global date
  // construction out of its shared state helpers.
  return (withinDay ? RESET_TIME_FORMATTER : RESET_TIME_WITH_WEEKDAY_FORMATTER).format(resetMs);
}

/**
 * The window's headline value: its percentage when the provider reports one,
 * otherwise the state its threshold status implies. A window with neither a
 * number nor a raised status has nothing to report but its own existence.
 */
export function describeProviderUsageWindowValue(window: ProviderUsageWindow): string {
  const percent = formatProviderUsagePercent(window.usedPercent);
  if (percent !== null) return percent;
  if (window.status === "critical") return "limit reached";
  return window.status === "warning" ? "limit warning" : "usage";
}

/** How long ago the account's snapshot was read. */
export function formatProviderUsageAge(observedAt: number | null, nowMs: number): string {
  if (observedAt === null) return "not updated yet";
  const ageMs = Math.max(0, nowMs - observedAt);
  if (ageMs < 60_000) return "updated just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `updated ${minutes}m ago`;
  return `updated ${Math.floor(minutes / 60)}h ago`;
}

export function isProviderUsageSnapshotStale(observedAt: number | null, nowMs: number): boolean {
  return observedAt === null || nowMs - observedAt > PROVIDER_USAGE_STALE_AFTER_MS;
}

/**
 * The age of the whole panel, which is its *oldest* account: one freshness
 * line stands in for every row, so it must not claim the panel is current on
 * the strength of the one account that happens to have been read last.
 * `null` — never read — is older than any timestamp.
 */
export function oldestProviderUsageObservedAt(
  accounts: ReadonlyArray<{ readonly observedAt: number | null }>,
): number | null {
  let oldest: number | null = null;
  for (const account of accounts) {
    if (account.observedAt === null) return null;
    if (oldest === null || account.observedAt < oldest) {
      oldest = account.observedAt;
    }
  }
  return oldest;
}

/**
 * Whether opening a usage surface should re-read. Keyed on the oldest account
 * for the same reason freshness is: a fresh sibling must not keep a lagging
 * account stale. With nothing listed there is nothing to compare, so the read
 * goes ahead.
 *
 * `lastRefreshStartedAtMs` (0 = never asked here) caps the cadence at one probe
 * per window whatever the accounts say. An account that never reports — expired
 * auth, a probe that always fails — stays `null` forever, and without this the
 * gate would spawn a probe per account on every single open.
 */
export function shouldRefreshProviderUsageOnOpen(
  accounts: ReadonlyArray<{ readonly observedAt: number | null }>,
  nowMs: number,
  lastRefreshStartedAtMs = 0,
): boolean {
  if (
    lastRefreshStartedAtMs !== 0 &&
    nowMs - lastRefreshStartedAtMs < PROVIDER_USAGE_REFRESH_ON_OPEN_AFTER_MS
  ) {
    return false;
  }
  if (accounts.length === 0) return true;
  const oldest = oldestProviderUsageObservedAt(accounts);
  return oldest === null || nowMs - oldest > PROVIDER_USAGE_REFRESH_ON_OPEN_AFTER_MS;
}

/** Bar fill for a window, including the "no number but not ok" case. */
export function providerUsageBarPercent(window: ProviderUsageWindow | null): number {
  if (window === null) return 0;
  if (window.usedPercent === null) return window.status === "ok" ? 0 : 100;
  return Math.max(0, Math.min(100, window.usedPercent));
}
