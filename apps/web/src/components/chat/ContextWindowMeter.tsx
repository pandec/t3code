import {
  primaryProviderUsageWindow,
  type ProviderUsageSnapshot,
  type ProviderUsageStatus,
  type ProviderUsageWindow,
} from "@t3tools/client-runtime/state/provider-usage";

import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * Two concentric rings in one control: the outer ring is the thread's context
 * window (unchanged behaviour and colours), the inner ring is the provider's
 * subscription quota. They answer the same question — how much room is left —
 * and are read at the same moment, so they share a control and a popover
 * rather than competing for space in the composer row.
 *
 * Only the quota ring uses warning/critical colour: a context window filling
 * up is normal and self-correcting, so colouring both would cry wolf.
 */

const MUTED_RING = "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
const RING_TRACK = "color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)";

const QUOTA_RING_COLOR: Record<ProviderUsageStatus, string> = {
  ok: MUTED_RING,
  warning: "var(--color-warning)",
  critical: "var(--color-destructive)",
};

const QUOTA_TEXT_CLASS: Record<ProviderUsageStatus, string> = {
  ok: "text-muted-foreground/70",
  warning: "text-warning-foreground",
  critical: "text-destructive",
};

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
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

function MeterRing(props: {
  readonly radius: number;
  readonly percentage: number;
  readonly color: string;
}) {
  const circumference = 2 * Math.PI * props.radius;
  return (
    <>
      <circle cx="12" cy="12" r={props.radius} fill="none" stroke={RING_TRACK} strokeWidth="2.5" />
      <circle
        cx="12"
        cy="12"
        r={props.radius}
        fill="none"
        stroke={props.color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference - (props.percentage / 100) * circumference}
        className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
      />
    </>
  );
}

function QuotaWindowRow(props: { window: ProviderUsageWindow; nowMs: number }) {
  const { window, nowMs } = props;
  const percent = formatPercentage(window.usedPercent);
  const resetTime = formatResetTime(window.resetsAt, nowMs);
  const barColor = QUOTA_RING_COLOR[window.status];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted-foreground/80">{window.label}</span>
        <span className={cn("text-[11px] tabular-nums", QUOTA_TEXT_CLASS[window.status])}>
          {percent ?? (window.status === "critical" ? "limit reached" : "limit warning")}
        </span>
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-muted/60"
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

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  providerUsage?: ProviderUsageSnapshot | null;
  providerDisplayName?: string | null;
}) {
  const { usage, providerUsage, providerDisplayName } = props;
  const nowMs = Date.now();

  const usedPercentage = usage ? formatPercentage(usage.usedPercentage) : null;
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  // Unchanged context-window colour rule: neutral until overloaded, then red.
  const contextColor =
    normalizedPercentage > 90
      ? "var(--color-red-500)"
      : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  const quotaWindow = providerUsage ? primaryProviderUsageWindow(providerUsage) : null;
  const quotaStatus = providerUsage?.status ?? "ok";
  const quotaColor = QUOTA_RING_COLOR[quotaWindow?.status ?? quotaStatus];
  const quotaPercentage = Math.max(0, Math.min(100, quotaWindow?.usedPercent ?? 0));
  const quotaPercentLabel = quotaWindow ? formatPercentage(quotaWindow.usedPercent) : null;

  const ariaLabel = [
    usage
      ? usage.maxTokens !== null && usedPercentage
        ? `Context window ${usedPercentage} used`
        : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
      : null,
    quotaWindow && quotaPercentLabel
      ? `${providerUsage?.providerLabel ?? "Provider"} ${quotaWindow.label} at ${quotaPercentLabel}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

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
              "inline-flex size-8 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={ariaLabel}
          >
            <span className="relative flex size-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu"
                aria-hidden="true"
              >
                {usage ? (
                  <MeterRing
                    radius={10.25}
                    percentage={normalizedPercentage}
                    color={contextColor}
                  />
                ) : null}
                {quotaWindow ? (
                  <MeterRing radius={6} percentage={quotaPercentage} color={quotaColor} />
                ) : null}
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        className="dropdown-glass w-64 max-w-none border-0! bg-secondary! p-0 shadow-none! before:hidden"
      >
        <div className="flex flex-col gap-3 p-3">
          {providerUsage ? (
            <div className="flex flex-col gap-2">
              <div className="font-medium text-muted-foreground text-xs">
                {providerUsage.providerLabel} Usage
              </div>
              {providerUsage.windows.map((window) => (
                <QuotaWindowRow key={window.id} window={window} nowMs={nowMs} />
              ))}
              {/* Quota is pulled at turn boundaries, so its age is meaningful
                  in a way the live context-window figure's is not. */}
              <div className="flex items-center justify-between gap-3 text-[11px] leading-4 text-muted-foreground/60">
                <span>Last updated</span>
                <span className="tabular-nums">
                  {new Intl.DateTimeFormat(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(new Date(providerUsage.updatedAt))}
                </span>
              </div>
            </div>
          ) : null}

          {providerUsage && usage ? <div className="h-px w-full bg-border/60" /> : null}

          {usage ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-muted-foreground text-xs">Context Window</div>
                {usage.maxTokens !== null && usedPercentage ? (
                  <div className="text-[11px] tabular-nums text-muted-foreground/70">
                    <span>{usedPercentage}</span>
                    <span className="mx-1">·</span>
                    <span>
                      {formatContextWindowTokens(usage.usedTokens)}/
                      {formatContextWindowTokens(usage.maxTokens ?? null)}
                    </span>
                  </div>
                ) : (
                  <div className="text-[11px] tabular-nums text-muted-foreground/70">
                    {formatContextWindowTokens(usage.usedTokens)}
                  </div>
                )}
              </div>
              {usage.maxTokens !== null ? (
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(normalizedPercentage)}
                  aria-label="Context window usage"
                >
                  <div
                    className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                    style={{ width: `${normalizedPercentage}%`, backgroundColor: contextColor }}
                  />
                </div>
              ) : null}
              {showTotalProcessed ? (
                <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                  <span className="text-muted-foreground/60">Total processed</span>
                  <span className="font-medium tabular-nums text-muted-foreground/80">
                    {formatContextWindowTokens(totalProcessedTokens)}
                  </span>
                </div>
              ) : null}
              {usage.compactsAutomatically ? (
                <div className="mt-1 text-pretty text-[11px] font-medium text-muted-foreground/70">
                  {providerDisplayName ?? "It"} automatically compacts its context when needed.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
