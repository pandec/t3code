import type { ProviderUsageWindow } from "@t3tools/client-runtime/state/provider-usage";

/**
 * Composer-toolbar side of mobile provider usage: the trigger pill's label and
 * the refresh guard. The detail view itself is `ProviderUsageSheet`, which draws
 * the same bars the desktop meter does.
 */

export function providerUsageTriggerLabel(window: ProviderUsageWindow | null): string {
  if (window?.status === "warning" || window?.status === "critical") {
    const percent = window.usedPercent !== null ? ` ${Math.round(window.usedPercent)}%` : "";
    return `${window.shortLabel}${percent}`;
  }
  return "Usage";
}

/** Minimum gap between refreshes; mirrors the web meter. */
export const PROVIDER_USAGE_REFRESH_DEBOUNCE_MS = 5_000;

/**
 * Whether a refresh may start now. A refresh can probe every listed account,
 * so a double-tap must not double-probe. `lastStartedAtMs` of 0 means "never
 * refreshed in this environment" and always allows the first attempt.
 */
export function canStartProviderUsageRefresh(lastStartedAtMs: number, nowMs: number): boolean {
  if (lastStartedAtMs === 0) return true;
  return nowMs - lastStartedAtMs >= PROVIDER_USAGE_REFRESH_DEBOUNCE_MS;
}
