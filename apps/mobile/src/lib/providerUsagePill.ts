import type {
  ProviderUsageSnapshot,
  ProviderUsageWindow,
} from "@t3tools/client-runtime/state/provider-usage";

/**
 * Composer-toolbar side of mobile provider usage: the trigger pill's label and
 * the refresh guard. The detail view itself is `ProviderUsageSheet` — a native
 * menu could only show one truncated line per account, so the rows moved to a
 * scrollable sheet that draws the same bars the desktop meter does.
 */

export function providerUsageTriggerLabel(window: ProviderUsageWindow | null): string {
  if (window?.status === "warning" || window?.status === "critical") {
    const percent = window.usedPercent !== null ? ` ${Math.round(window.usedPercent)}%` : "";
    return `${window.shortLabel}${percent}`;
  }
  return "Usage";
}

export interface ProviderUsageSheetAccount {
  readonly instanceId: string;
  /**
   * Distinguishes pooled gateway accounts that share one instance id; rows
   * for regular instances omit it and key on the instance id alone.
   */
  readonly accountKey?: string;
  readonly displayName: string;
  readonly email: string | undefined;
  /**
   * Whether this account serves the active thread. For a direct instance that
   * is the instance the thread runs on; for a pooled gateway account it is set
   * only once the gateway confirmed the session's sticky binding — the pool's
   * priority order alone cannot tell, so unprobed pools mark no row current.
   */
  readonly isCurrent: boolean;
  /**
   * Gateway pools only: the account the failover ladder would bind a *new*
   * session to. Distinct from `isCurrent` because an existing session's
   * binding outranks priority.
   */
  readonly isNext?: boolean;
  readonly snapshot: ProviderUsageSnapshot | null;
  readonly observedAt: number | null;
  /** Secondary metadata, e.g. a gateway account's tier and cooldown. */
  readonly detail?: string | null;
  /** Why this account has no usage; rendered on its own line when present. */
  readonly error?: string | null;
}

/** Minimum gap between refreshes; mirrors the web meter. */
export const PROVIDER_USAGE_REFRESH_DEBOUNCE_MS = 5_000;

/**
 * Whether a refresh may start now. A refresh can spawn one CLI probe per
 * account, so a double-tap must not double-spawn. `lastStartedAtMs` of 0 means
 * "never refreshed in this environment" and always allows the first attempt.
 */
export function canStartProviderUsageRefresh(lastStartedAtMs: number, nowMs: number): boolean {
  if (lastStartedAtMs === 0) return true;
  return nowMs - lastStartedAtMs >= PROVIDER_USAGE_REFRESH_DEBOUNCE_MS;
}
