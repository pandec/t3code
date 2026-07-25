import type {
  ProviderUsageSnapshot,
  ProviderUsageWindow,
} from "@t3tools/client-runtime/state/provider-usage";

/**
 * Presentation helpers for the mobile provider usage pill: the composer
 * toolbar trigger label and the native-menu rows (one per rate-limit window).
 * Hover popovers don't exist on mobile, so the detail view is a tap-opened
 * `ControlPillMenu` with the window facts in each row's subtitle.
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
  return resetTime ? `${usage} · resets ${resetTime}` : usage;
}

export function providerUsageMenuActions(
  snapshot: ProviderUsageSnapshot,
  nowMs: number,
): Array<{ id: string; title: string; subtitle: string }> {
  return snapshot.windows.map((window) => ({
    id: `usage:${window.id}`,
    title: window.label,
    subtitle: describeWindow(window, nowMs),
  }));
}
