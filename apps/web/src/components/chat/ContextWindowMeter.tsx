import {
  applyProviderUsageThresholds,
  primaryProviderUsageWindow,
  type ProviderUsageSnapshot,
  type ProviderUsageStatus,
  type ProviderUsageWindow,
} from "@t3tools/client-runtime/state/provider-usage";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";

import { useProviderUsageThresholds } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { formatProviderUsageEmail } from "~/providerUsageEmail";
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

const QUOTA_STATUS_RANK: Record<ProviderUsageStatus, number> = { ok: 0, warning: 1, critical: 2 };

function maxProviderUsageStatus(
  a: ProviderUsageStatus,
  b: ProviderUsageStatus,
): ProviderUsageStatus {
  return QUOTA_STATUS_RANK[b] > QUOTA_STATUS_RANK[a] ? b : a;
}

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

export interface ProviderUsageAccountRow {
  readonly instanceId: ProviderInstanceId;
  /**
   * Distinguishes pooled gateway accounts that share one instance id; rows
   * for regular instances omit it and key on the instance id alone.
   */
  readonly accountKey?: string;
  readonly displayName: string;
  readonly email: string | undefined;
  /** Whether the thread's live session is currently spending this account. */
  readonly isCurrent: boolean;
  readonly usage: ProviderUsageSnapshot | null;
  readonly observedAt: number | null;
  /** Secondary metadata line, e.g. a gateway account's tier and cooldown. */
  readonly detail?: string | null;
}

function formatRelativeAge(observedAt: number | null, nowMs: number): string {
  if (observedAt === null) return "not updated yet";
  const ageMs = Math.max(0, nowMs - observedAt);
  if (ageMs < 60_000) return "updated just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `updated ${hours}h ago`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  providerUsage?: ProviderUsageSnapshot | null;
  providerUsageAccounts?: ReadonlyArray<ProviderUsageAccountRow>;
  providerUsageRefreshing?: boolean;
  /**
   * The usage read itself failed, as opposed to succeeding with nothing to
   * show. Without the distinction a failed read is indistinguishable from an
   * account that simply has no snapshot yet.
   */
  providerUsageUnavailable?: boolean;
  maskProviderUsageEmails?: boolean;
  /** Driver-derived label ("Claude", "Codex") for the accounts header. */
  providerUsageLabel?: string | null;
  providerDisplayName?: string | null;
  onRefreshProviderUsage?: () => Promise<void> | void;
}) {
  const { usage, providerDisplayName } = props;
  // Colour thresholds are a user setting; re-evaluate the snapshot on read so a
  // change applies to whatever is already on screen.
  const usageThresholds = useProviderUsageThresholds();
  const providerUsage = useMemo(
    () => applyProviderUsageThresholds(props.providerUsage ?? null, usageThresholds),
    [props.providerUsage, usageThresholds],
  );
  const providerUsageAccounts = useMemo(
    () =>
      (props.providerUsageAccounts ?? []).map((account) => ({
        ...account,
        usage: applyProviderUsageThresholds(account.usage, usageThresholds),
      })),
    [props.providerUsageAccounts, usageThresholds],
  );
  const nowMs = Date.now();
  const newestObservedAt = providerUsageAccounts.reduce<number | null>(
    (newest, account) =>
      account.observedAt !== null && (newest === null || account.observedAt > newest)
        ? account.observedAt
        : newest,
    null,
  );

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
  // Colour by the worst window, not just the featured one: the ring must never
  // render a calmer state than the snapshot as a whole.
  const quotaStatus = maxProviderUsageStatus(
    providerUsage?.status ?? "ok",
    quotaWindow?.status ?? "ok",
  );
  const quotaColor = QUOTA_RING_COLOR[quotaStatus];
  // A window with a state but no number (Claude reports `rejected` without
  // utilization) still has to be visible — fill the ring rather than drawing a
  // zero-length arc that paints nothing.
  const quotaPercentage =
    quotaWindow?.usedPercent === null || quotaWindow?.usedPercent === undefined
      ? quotaWindow !== null && quotaStatus !== "ok"
        ? 100
        : 0
      : Math.max(0, Math.min(100, quotaWindow.usedPercent));
  const quotaPercentLabel = quotaWindow ? formatPercentage(quotaWindow.usedPercent) : null;
  const quotaAriaLabel = quotaWindow
    ? quotaPercentLabel
      ? `${providerUsage?.providerLabel ?? "Provider"} ${quotaWindow.label} at ${quotaPercentLabel}`
      : `${providerUsage?.providerLabel ?? "Provider"} ${quotaWindow.label} ${
          quotaWindow.status === "critical"
            ? "limit reached"
            : quotaWindow.status === "warning"
              ? "limit warning"
              : "usage"
        }`
    : providerUsage
      ? `${providerUsage.providerLabel} usage`
      : null;

  const ariaLabel = [
    usage
      ? usage.maxTokens !== null && usedPercentage
        ? `Context window ${usedPercentage} used`
        : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
      : null,
    quotaAriaLabel,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Popover
      onOpenChange={(open) => {
        if (
          open &&
          props.onRefreshProviderUsage !== undefined &&
          (newestObservedAt === null || nowMs - newestObservedAt > 60_000)
        ) {
          void props.onRefreshProviderUsage();
        }
      }}
    >
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
          {providerUsage && providerUsageAccounts.length === 0 ? (
            <div className="flex flex-col gap-2">
              <div className="font-medium text-muted-foreground text-xs">
                {providerUsage.providerLabel} Usage
              </div>
              {providerUsage.windows.map((window) => (
                <QuotaWindowRow key={window.id} window={window} nowMs={nowMs} />
              ))}
            </div>
          ) : null}

          {providerUsageAccounts.length > 0 ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-muted-foreground text-xs">
                  {props.providerUsageLabel ?? providerUsage?.providerLabel ?? "Provider"} accounts
                </div>
                {props.onRefreshProviderUsage ? (
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void props.onRefreshProviderUsage?.()}
                    disabled={props.providerUsageRefreshing}
                    aria-label="Refresh provider usage"
                  >
                    <RefreshCwIcon
                      className={cn("size-3", props.providerUsageRefreshing && "animate-spin")}
                    />
                  </button>
                ) : null}
              </div>
              {providerUsageAccounts.map((account) => {
                const stale =
                  account.observedAt === null || nowMs - account.observedAt > 5 * 60_000;
                return (
                  <div
                    key={account.accountKey ?? account.instanceId}
                    className={cn("flex flex-col gap-2", stale && "opacity-55")}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[11px] font-medium text-muted-foreground/90">
                            {account.displayName}
                          </span>
                          {account.isCurrent && providerUsageAccounts.length > 1 ? (
                            <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
                              current
                            </span>
                          ) : null}
                        </span>
                        {account.email ? (
                          <span className="max-w-44 truncate text-left text-[11px] text-muted-foreground/60">
                            {formatProviderUsageEmail(account.email, props.maskProviderUsageEmails)}
                          </span>
                        ) : null}
                        {account.detail ? (
                          <span className="max-w-44 truncate text-left text-[11px] text-muted-foreground/60">
                            {account.detail}
                          </span>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                        {props.providerUsageRefreshing
                          ? "updating…"
                          : formatRelativeAge(account.observedAt, nowMs)}
                      </span>
                    </div>
                    {account.usage ? (
                      account.usage.windows.map((window) => (
                        <QuotaWindowRow key={window.id} window={window} nowMs={nowMs} />
                      ))
                    ) : (
                      <div className="text-[11px] text-muted-foreground/60">
                        {props.providerUsageUnavailable
                          ? "Couldn't load usage"
                          : "No usage data available"}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          {(providerUsage || providerUsageAccounts.length > 0) && usage ? (
            <div className="h-px w-full bg-border/60" />
          ) : null}

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
