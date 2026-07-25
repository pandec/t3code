import type {
  ProviderUsageSnapshot,
  ProviderUsageStatus,
  ProviderUsageWindow,
} from "@t3tools/client-runtime/state/provider-usage";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const BAR_COLOR_BY_STATUS: Record<ProviderUsageStatus, string> = {
  ok: "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)",
  warning: "var(--color-warning)",
  critical: "var(--color-destructive)",
};

const TEXT_CLASS_BY_STATUS: Record<ProviderUsageStatus, string> = {
  ok: "text-muted-foreground",
  warning: "text-warning-foreground",
  critical: "text-destructive",
};

function formatPercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `${Math.round(value)}%`;
}

function formatResetTime(resetsAt: number | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const resetMs = resetsAt * 1_000;
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
  const date = new Date(resetMs);
  const withinDay = resetMs - nowMs < 24 * 60 * 60 * 1_000;
  return new Intl.DateTimeFormat(undefined, {
    ...(withinDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function UsageWindowRow(props: { window: ProviderUsageWindow; nowMs: number }) {
  const { window, nowMs } = props;
  const percent = formatPercent(window.usedPercent);
  const resetTime = formatResetTime(window.resetsAt, nowMs);
  const barColor = BAR_COLOR_BY_STATUS[window.status];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">{window.label}</span>
        <span
          className={cn(
            "text-[11px] tabular-nums",
            window.status === "ok"
              ? "text-muted-foreground/70"
              : TEXT_CLASS_BY_STATUS[window.status],
          )}
        >
          {percent ?? (window.status === "critical" ? "limit reached" : "limit warning")}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(window.usedPercent !== null
          ? { "aria-valuenow": Math.round(window.usedPercent) }
          : {})}
        aria-label={`${window.label} usage`}
      >
        {window.usedPercent !== null ? (
          <div
            className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${window.usedPercent}%`, backgroundColor: barColor }}
          />
        ) : null}
      </div>
      {resetTime ? (
        <div className="text-right text-[11px] tabular-nums text-muted-foreground/60">
          resets {resetTime}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Subscription-quota meter for the composer status row. Quiet while usage is
 * unremarkable; the trigger expands inline with the constrained window and its
 * percentage once a warning threshold is crossed. Details live in the hover
 * popover: one row per rate-limit window, reset times in local time.
 */
export function ProviderUsageMeter(props: { snapshot: ProviderUsageSnapshot }) {
  const { snapshot } = props;
  const nowMs = Date.now();
  const constrained = snapshot.constrainedWindow;
  const constrainedPercent = constrained ? formatPercent(constrained.usedPercent) : null;
  const updatedTime = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(snapshot.updatedAt));

  // A micro bar chart, one bar per window (windows are few: session + weeklies).
  const bars = snapshot.windows.slice(0, 4);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-transparent px-1.5 outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              TEXT_CLASS_BY_STATUS[snapshot.status],
            )}
            aria-label={
              constrained && constrainedPercent
                ? `${snapshot.providerLabel} usage: ${constrained.label} at ${constrainedPercent}`
                : `${snapshot.providerLabel} usage`
            }
          >
            <span className="flex h-3.5 items-end gap-[2.5px]" aria-hidden="true">
              {bars.map((window) => (
                <span
                  key={window.id}
                  className="w-[3px] rounded-[1px] transition-[height,background-color] duration-500 ease-out motion-reduce:transition-none"
                  style={{
                    // Keep a visible stub even near 0% so the glyph reads as bars.
                    height: `${Math.max(18, window.usedPercent ?? 18)}%`,
                    backgroundColor: BAR_COLOR_BY_STATUS[window.status],
                  }}
                />
              ))}
            </span>
            {snapshot.status !== "ok" && constrained ? (
              <span className="text-[11px] font-medium tabular-nums">
                {constrained.shortLabel}
                {constrainedPercent ? ` ${constrainedPercent}` : ""}
              </span>
            ) : null}
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        className="dropdown-glass w-64 max-w-none border-0! bg-secondary! p-0 shadow-none! before:hidden"
      >
        <div className="flex flex-col gap-2.5 p-3">
          <div className="font-medium text-muted-foreground text-xs">
            {snapshot.providerLabel} Usage
          </div>
          {snapshot.windows.map((window) => (
            <UsageWindowRow key={window.id} window={window} nowMs={nowMs} />
          ))}
          <div className="flex items-center justify-between gap-3 text-[11px] leading-4 text-muted-foreground/60">
            <span>Last updated</span>
            <span className="tabular-nums">{updatedTime}</span>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
