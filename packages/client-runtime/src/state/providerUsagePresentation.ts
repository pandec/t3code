import type { ProviderUsageWindow } from "./providerUsage.js";

/**
 * Formatting shared by every surface that renders provider quota: the web
 * composer meter popover and the mobile usage sheet. Both show the same facts
 * (percent, reset time, snapshot freshness), so they must phrase them the same
 * way — the strings previously drifted because each client formatted its own.
 */

/** A snapshot older than this is dimmed as stale rather than trusted. */
export const PROVIDER_USAGE_STALE_AFTER_MS = 5 * 60_000;

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
  return new Intl.DateTimeFormat(undefined, {
    ...(withinDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(resetMs);
}

/**
 * The window's headline value: its percentage when the provider reports one,
 * otherwise the state its threshold status implies.
 */
export function describeProviderUsageWindowValue(window: ProviderUsageWindow): string {
  return (
    formatProviderUsagePercent(window.usedPercent) ??
    (window.status === "critical" ? "limit reached" : "limit warning")
  );
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

/** Bar fill for a window, including the "no number but not ok" case. */
export function providerUsageBarPercent(window: ProviderUsageWindow | null): number {
  if (window === null) return 0;
  if (window.usedPercent === null) return window.status === "ok" ? 0 : 100;
  return Math.max(0, Math.min(100, window.usedPercent));
}
