import type {
  ProviderUsageSnapshot,
  ProviderUsageWindow,
} from "@t3tools/client-runtime/state/provider-usage";

/**
 * Presentation helpers for the mobile provider usage pill: the composer
 * toolbar trigger label and the native-menu rows (one per configured
 * account). Hover popovers don't exist on mobile, so the detail view is a
 * tap-opened `ControlPillMenu` with the account facts in each row's subtitle.
 */

export function providerUsageTriggerLabel(snapshot: ProviderUsageSnapshot): string {
  const constrained = snapshot.constrainedWindow;
  if (constrained) {
    const percent =
      constrained.usedPercent !== null ? ` ${Math.round(constrained.usedPercent)}%` : "";
    return `${constrained.shortLabel}${percent}`;
  }
  return "Usage";
}

function formatResetTime(resetsAt: number | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const resetMs = resetsAt * 1_000;
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
  const withinDay = resetMs - nowMs < 24 * 60 * 60 * 1_000;
  return new Intl.DateTimeFormat(undefined, {
    ...(withinDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetMs));
}

function describeWindow(window: ProviderUsageWindow, nowMs: number): string {
  const usage =
    window.usedPercent !== null
      ? `${Math.round(window.usedPercent)}% used`
      : window.status === "critical"
        ? "Limit reached"
        : "Limit warning";
  const resetTime = formatResetTime(window.resetsAt, nowMs);
  const detail = resetTime ? `${usage} · resets ${resetTime}` : usage;
  return `${window.label}: ${detail}`;
}

export interface ProviderUsageMenuAccount {
  readonly instanceId: string;
  readonly displayName: string;
  readonly email: string | undefined;
  /** Whether the thread's live session is currently spending this account. */
  readonly isCurrent: boolean;
  readonly snapshot: ProviderUsageSnapshot | null;
  readonly observedAt: number | null;
}

function formatRelativeAge(observedAt: number | null, nowMs: number): string {
  if (observedAt === null) return "not updated";
  const minutes = Math.floor(Math.max(0, nowMs - observedAt) / 60_000);
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes}m ago`;
  return `updated ${Math.floor(minutes / 60)}h ago`;
}

/**
 * Menu row id for the refresh action. Exported so the composer can match the
 * pressed row without re-deriving the string.
 */
export const PROVIDER_USAGE_REFRESH_ACTION_ID = "usage-refresh";

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

/**
 * One native-menu row per configured account, plus a trailing refresh row.
 *
 * The account rows are informational; only the refresh row is actionable, so
 * the composer keys on `PROVIDER_USAGE_REFRESH_ACTION_ID` and ignores the rest.
 */
export function providerUsageAccountMenuActions(
  accounts: ReadonlyArray<ProviderUsageMenuAccount>,
  nowMs: number,
  options?: { readonly refreshing?: boolean },
): Array<{ id: string; title: string; subtitle: string }> {
  const rows = accounts.map((account) => {
    const windows =
      account.snapshot?.windows.map((window) => describeWindow(window, nowMs)).join(", ") ??
      "No usage data";
    return {
      id: `usage-account:${account.instanceId}`,
      // Mark the account the session is spending, but only when there is a
      // sibling to distinguish it from.
      title:
        account.isCurrent && accounts.length > 1
          ? `${account.displayName} (current)`
          : account.displayName,
      subtitle: [account.email, windows, formatRelativeAge(account.observedAt, nowMs)]
        .filter((value): value is string => Boolean(value))
        .join(" · "),
    };
  });
  return [
    ...rows,
    {
      id: PROVIDER_USAGE_REFRESH_ACTION_ID,
      title: options?.refreshing === true ? "Refreshing…" : "Refresh",
      subtitle:
        options?.refreshing === true
          ? "Reading usage from each account"
          : "Read current usage for every account",
    },
  ];
}
