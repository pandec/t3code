import {
  collectProviderUsageAlerts,
  type ProviderUsageAlert,
  type ProviderUsageSnapshot,
} from "@t3tools/client-runtime/state/provider-usage";
import { useEffect } from "react";

import { toastManager } from "../components/ui/toast";
import { useClientSettings } from "../hooks/useSettings";
import { showSystemNotification } from "./turnCompletion";

/**
 * Threshold notifications for the provider usage meter: fires once per window
 * per threshold per reset period when subscription usage crosses the warning
 * or critical threshold. De-dupe keys are persisted in localStorage (keyed by
 * the window's reset time) so reloads and event replay stay silent; entries
 * expire with their reset period.
 */

const FIRED_ALERTS_STORAGE_KEY = "t3.providerUsage.firedAlertKeys";
const UNKNOWN_RESET_TTL_MS = 24 * 60 * 60 * 1_000;

function readFiredAlerts(nowMs: number): Map<string, number> {
  const fired = new Map<string, number>();
  try {
    const raw = window.localStorage.getItem(FIRED_ALERTS_STORAGE_KEY);
    if (!raw) return fired;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fired;
    for (const [key, expiresAtMs] of Object.entries(parsed)) {
      if (typeof expiresAtMs === "number" && expiresAtMs > nowMs) {
        fired.set(key, expiresAtMs);
      }
    }
  } catch {
    // Unreadable storage just means alerts may re-fire once; not worth surfacing.
  }
  return fired;
}

function writeFiredAlerts(fired: Map<string, number>): void {
  try {
    window.localStorage.setItem(
      FIRED_ALERTS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(fired)),
    );
  } catch {
    // Best-effort persistence; in-session de-dupe still holds via the snapshot.
  }
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

export function buildProviderUsageAlertCopy(
  alert: ProviderUsageAlert,
  nowMs: number,
): { title: string; body: string } {
  const percent =
    alert.window.usedPercent !== null ? `${Math.round(alert.window.usedPercent)}%` : null;
  const resetTime = formatResetTime(alert.window.resetsAt, nowMs);
  const title =
    alert.threshold === "critical"
      ? `${alert.providerLabel} rate limit almost reached`
      : `${alert.providerLabel} rate limit warning`;
  const body = [
    `${alert.window.label} is at ${percent ?? "its limit"}`,
    resetTime ? `resets ${resetTime}` : null,
  ]
    .filter(Boolean)
    .join(" — ");
  return { title, body: `${body}.` };
}

export function useProviderUsageAlerts(snapshot: ProviderUsageSnapshot | null): void {
  const enabled = useClientSettings((settings) => settings.enableRateLimitAlerts);

  useEffect(() => {
    if (!enabled || !snapshot) return;
    const nowMs = Date.now();
    const fired = readFiredAlerts(nowMs);
    const alerts = collectProviderUsageAlerts(snapshot, new Set(fired.keys()));
    if (alerts.length === 0) return;

    for (const alert of alerts) {
      const expiresAtMs =
        alert.window.resetsAt !== null
          ? alert.window.resetsAt * 1_000
          : nowMs + UNKNOWN_RESET_TTL_MS;
      for (const key of alert.keys) {
        fired.set(key, expiresAtMs);
      }
      const { title, body } = buildProviderUsageAlertCopy(alert, nowMs);
      toastManager.add({
        type: alert.threshold === "critical" ? "error" : "warning",
        title,
        description: body,
      });
      // The toast covers the focused app; the system notification covers the
      // rest, mirroring turn-completion's delivery split.
      if (!(document.visibilityState === "visible" && document.hasFocus())) {
        void showSystemNotification({ title, body });
      }
    }
    writeFiredAlerts(fired);
  }, [enabled, snapshot]);
}
