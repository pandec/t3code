import {
  applyProviderUsageThresholds,
  applyProviderUsageWindowThresholds,
  primaryProviderUsageWindow,
  providerUsageRingStatus,
  type ProviderUsageSnapshot,
  type ProviderUsageStatus,
  type ProviderUsageWindow,
} from "@t3tools/client-runtime/state/provider-usage";
import {
  describeProviderUsageWindowValue,
  formatProviderUsageAge,
  formatProviderUsagePercent,
  formatProviderUsageResetTime,
  isProviderUsageSnapshotStale,
  oldestProviderUsageObservedAt,
  providerUsageBarPercent,
  shouldRefreshProviderUsageOnOpen,
} from "@t3tools/client-runtime/state/provider-usage-presentation";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { CircleDollarSignIcon, Minimize2Icon, RefreshCwIcon } from "lucide-react";
import { Fragment, useMemo, useRef } from "react";

import { useProviderUsageThresholds } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { formatProviderUsageEmail } from "~/providerUsageEmail";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { composerFloatingLayerProps } from "./composerEventScope";

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
        strokeDashoffset={circumference * (1 - props.percentage / 100)}
        className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
      />
    </>
  );
}

function MeterPie(props: { readonly percentage: number; readonly color: string }) {
  const radius = 2.5;
  const angle = (props.percentage / 100) * Math.PI * 2;
  const endX = 12 + radius * Math.cos(angle);
  const endY = 12 + radius * Math.sin(angle);

  return (
    <>
      <circle cx="12" cy="12" r={radius} fill={RING_TRACK} />
      {props.percentage >= 100 ? (
        <circle cx="12" cy="12" r={radius} fill={props.color} />
      ) : props.percentage > 0 ? (
        <path
          d={`M 12 12 L ${12 + radius} 12 A ${radius} ${radius} 0 ${props.percentage > 50 ? 1 : 0} 1 ${endX} ${endY} Z`}
          fill={props.color}
          className="transition-colors duration-500 motion-reduce:transition-none"
        />
      ) : null}
    </>
  );
}

function QuotaWindowRow(props: { window: ProviderUsageWindow; nowMs: number }) {
  const { window, nowMs } = props;
  const resetTime = formatProviderUsageResetTime(window.resetsAt, nowMs);
  const barColor = QUOTA_RING_COLOR[window.status];

  return (
    <div className="flex flex-col gap-1">
      {/* Label and reset share a line so an account costs two lines per window
          rather than three — the popover has to hold every pooled account. */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground/80">
          {window.label}
          {resetTime ? (
            <span className="text-muted-foreground/55"> · resets {resetTime}</span>
          ) : null}
        </span>
        <span className={cn("shrink-0 text-[11px] tabular-nums", QUOTA_TEXT_CLASS[window.status])}>
          {describeProviderUsageWindowValue(window)}
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
    </div>
  );
}

/**
 * OpenRouter account balance shown in the popover when the user enabled it in
 * Settings → Extras. Account-wide (one OpenRouter account per environment), so
 * it is independent of the provider accounts listed above it.
 */
export interface OpenRouterCreditsDisplay {
  /** Whether the environment holds an API key at all. */
  readonly configured: boolean;
  /** Credits remaining in USD; null while unconfigured or failed. */
  readonly balanceUsd: number | null;
  readonly observedAt: number | null;
  readonly error: string | null;
  /**
   * The read RPC itself failed (environment offline, older server), as
   * opposed to a server-side fetch failure reported inside the result. The
   * shown balance, if any, is the previous read's — say so rather than
   * presenting it as current.
   */
  readonly unavailable: boolean;
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
  readonly usage: ProviderUsageSnapshot | null;
  readonly observedAt: number | null;
  /** Secondary metadata, e.g. a gateway account's tier and cooldown. */
  readonly detail?: string | null;
  /** Why this account has no usage; rendered on its own line when present. */
  readonly error?: string | null;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  providerUsage?: ProviderUsageSnapshot | null;
  fableUsage?: ProviderUsageWindow | null;
  fableAccountName?: string | null;
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
  /** Selected model, named in the automatic-compaction note. */
  modelDisplayName?: string | null;
  onRefreshProviderUsage?: () => Promise<void> | void;
  /**
   * Called on every popover open, unlike the staleness-gated refresh: the
   * thread-account binding is one cheap request and can change independently
   * of the pool's quota data. The callback throttles itself; the refresh
   * button passes `force` because an explicit ask outranks the cadence cap.
   */
  onProbeThreadAccount?: (options?: { readonly force?: boolean }) => void;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
  openRouterCredits?: OpenRouterCreditsDisplay | null;
  /** Called on popover open, at most once a minute; re-reads the balance. */
  onRefreshOpenRouterCredits?: () => void;
}) {
  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
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
  const fableUsage = useMemo(
    () =>
      props.fableUsage
        ? applyProviderUsageWindowThresholds(props.fableUsage, usageThresholds)
        : null,
    [props.fableUsage, usageThresholds],
  );
  const nowMs = Date.now();
  const panelObservedAt = oldestProviderUsageObservedAt(providerUsageAccounts);
  // When this popover last asked for a read, so an account that never reports
  // can't turn every open into another probe of the whole pool.
  const lastRefreshAskedAtRef = useRef(0);
  // Same idea for the OpenRouter balance: OpenRouter caches the endpoint for
  // about a minute, so a hover-triggered popover must not re-ask faster.
  const lastOpenRouterRefreshAskedAtRef = useRef(0);

  const usedPercentage = usage ? formatProviderUsagePercent(usage.usedPercentage) : null;
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  // Unchanged context-window colour rule: neutral until overloaded, then red.
  const contextColor =
    normalizedPercentage > 90
      ? "var(--color-error)"
      : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  const quotaWindow = providerUsage ? primaryProviderUsageWindow(providerUsage) : null;
  // The value stays on the primary session/weekly window, but the ring must
  // never render a calmer state than the windows it is the only signal for.
  // Fable is excluded: its own sub-ring carries that signal.
  const quotaStatus = providerUsageRingStatus(providerUsage, fableUsage?.id ?? null);
  const quotaColor = QUOTA_RING_COLOR[quotaStatus];
  const quotaPercentage = providerUsageBarPercent(quotaWindow);
  const quotaPercentLabel = quotaWindow
    ? formatProviderUsagePercent(quotaWindow.usedPercent)
    : null;
  const fablePercentage = providerUsageBarPercent(fableUsage);
  // The Fable account is named by its email, so it obeys the masking preference
  // exactly like the account rows do — including in the accessible label.
  const fableAccountName =
    props.fableAccountName && props.fableAccountName.includes("@")
      ? formatProviderUsageEmail(props.fableAccountName, props.maskProviderUsageEmails)
      : (props.fableAccountName ?? null);
  const fableAriaLabel = fableUsage
    ? `Weekly Fable${fableAccountName ? ` on ${fableAccountName}` : ""} at ${describeProviderUsageWindowValue(fableUsage)}`
    : null;
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
  const openRouterAriaLabel = props.openRouterCredits
    ? props.openRouterCredits.balanceUsd !== null
      ? `OpenRouter credits ${formatUsd(props.openRouterCredits.balanceUsd)} left`
      : props.openRouterCredits.unavailable
        ? "OpenRouter credits unavailable"
        : props.openRouterCredits.error !== null
          ? "OpenRouter credits error"
          : props.openRouterCredits.configured
            ? "OpenRouter credits"
            : "OpenRouter credits not configured"
    : null;
  const showOpenRouterOnlyIndicator = Boolean(
    props.openRouterCredits && !usage && !quotaWindow && !fableUsage,
  );

  const ariaLabel = [
    usage
      ? usage.maxTokens !== null && usedPercentage !== null
        ? `Context window ${usedPercentage} used`
        : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
      : null,
    quotaAriaLabel,
    fableAriaLabel,
    openRouterAriaLabel,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          props.onProbeThreadAccount?.();
        }
        if (
          open &&
          props.onRefreshProviderUsage !== undefined &&
          shouldRefreshProviderUsageOnOpen(
            providerUsageAccounts,
            nowMs,
            lastRefreshAskedAtRef.current,
          )
        ) {
          lastRefreshAskedAtRef.current = nowMs;
          void props.onRefreshProviderUsage();
        }
        // Read the clock here, not at render: a popover opened right after a
        // long-backgrounded tab resumes would otherwise compare two equally
        // old timestamps and skip the refresh the user came for.
        const openedAtMs = Date.now();
        // Gated on the display too: with the feature off the callback is
        // bound to the shared empty-query sentinel, which must not be
        // refreshed on behalf of a block that is not even rendered.
        if (
          open &&
          props.openRouterCredits &&
          props.onRefreshOpenRouterCredits !== undefined &&
          openedAtMs - lastOpenRouterRefreshAskedAtRef.current >= 60_000
        ) {
          lastOpenRouterRefreshAskedAtRef.current = openedAtMs;
          props.onRefreshOpenRouterCredits();
        }
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={ariaLabel}
          >
            <span className="relative flex size-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
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
                {fableUsage ? (
                  <MeterPie
                    percentage={fablePercentage}
                    color={QUOTA_RING_COLOR[fableUsage.status]}
                  />
                ) : null}
              </svg>
              {showOpenRouterOnlyIndicator ? (
                <CircleDollarSignIcon
                  aria-hidden
                  className="size-4 text-muted-foreground/70"
                  data-testid="openrouter-credits-indicator"
                />
              ) : null}
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-80 max-w-none text-left whitespace-normal"
      >
        {/* The popover viewport clips instead of scrolling, so the content
            bounds itself and scrolls the usage list internally. A pooled gateway
            lists every account it can serve, which easily outgrows the screen —
            the header and the context window below have to stay reachable.

            Two nested caps, not one min(): Base UI measures the popup with
            --available-height set to `max-content`, which makes any length
            expression using it invalid for that pass. The outer viewport-unit
            cap is always valid, so the height the positioner commits is bounded
            even during measurement; the inner cap then trims to the room
            actually available. The outer element scrolls as a last resort, so a
            viewport too short even for the pinned rows stays reachable.

            The outer cap is deliberately generous: on a full desktop window the
            inner cap is the smaller of the two, so the panel uses the room that
            actually exists instead of scrolling a list that would have fit. */}
        <div className="flex max-h-[85vh] flex-col overflow-y-auto overscroll-contain">
          <div className="flex max-h-(--available-height) min-h-0 flex-col gap-3 p-[var(--floating-content-inset)]">
            {providerUsageAccounts.length > 0 ? (
              <div className="flex shrink-0 items-center justify-between gap-3">
                <div className="font-medium text-muted-foreground text-xs">
                  {props.providerUsageLabel ?? providerUsage?.providerLabel ?? "Provider"} accounts
                </div>
                <div className="flex items-center gap-2">
                  {/* One freshness line for the whole read replaces the identical
                    per-account timestamps, and reports the oldest of them so a
                    freshly-read sibling can't vouch for a lagging account. */}
                  <span className="text-[10px] tabular-nums text-muted-foreground/60">
                    {props.providerUsageRefreshing
                      ? "updating…"
                      : formatProviderUsageAge(panelObservedAt, nowMs)}
                  </span>
                  {props.onRefreshProviderUsage ? (
                    <button
                      type="button"
                      className="inline-flex size-6 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => {
                        lastRefreshAskedAtRef.current = Date.now();
                        props.onProbeThreadAccount?.({ force: true });
                        void props.onRefreshProviderUsage?.();
                      }}
                      disabled={props.providerUsageRefreshing}
                      aria-label="Refresh provider usage"
                    >
                      <RefreshCwIcon
                        className={cn("size-3", props.providerUsageRefreshing && "animate-spin")}
                      />
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {providerUsageAccounts.length > 0 && fableUsage && fableAccountName ? (
              <div className="flex shrink-0 items-center justify-between gap-3 text-[11px]">
                <span className="text-muted-foreground/70">Fable next</span>
                <span className="truncate font-medium text-muted-foreground/90">
                  {fableAccountName}
                </span>
              </div>
            ) : null}

            {providerUsage || providerUsageAccounts.length > 0 ? (
              // Focusable and labelled: the rows hold no controls, so without a
              // tab stop a keyboard user has nothing to scroll the list from.
              <div
                className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain rounded outline-none focus-visible:ring-1 focus-visible:ring-ring"
                tabIndex={0}
                role="group"
                aria-label={`${props.providerUsageLabel ?? providerUsage?.providerLabel ?? "Provider"} usage`}
              >
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

                {providerUsageAccounts.map((account, index) => {
                  const stale = isProviderUsageSnapshotStale(account.observedAt, nowMs);
                  return (
                    <Fragment key={account.accountKey ?? account.instanceId}>
                      {/* Every account is fenced off from the one above it: the
                          rows are dense enough that a gap alone reads as one
                          account's windows continuing. */}
                      {index > 0 ? <div className="h-px w-full shrink-0 bg-border/60" /> : null}
                      <div className={cn("flex flex-col gap-2", stale && "opacity-55")}>
                        <div className="flex items-start justify-between gap-3">
                          {/* Name, email, and metadata share one line: the pool
                              easily reaches six accounts, and three lines each
                              pushed the context window off screen. */}
                          <span className="flex min-w-0 items-baseline gap-1.5 text-[11px]">
                            {/* A pooled account's name is short ("Claude"), but
                                a direct instance's is a user-chosen string that
                                would otherwise squeeze out everything after it. */}
                            <span className="min-w-0 truncate font-semibold text-muted-foreground/90">
                              {account.displayName}
                            </span>
                            {account.email ? (
                              <span className="truncate text-muted-foreground/70">
                                {formatProviderUsageEmail(
                                  account.email,
                                  props.maskProviderUsageEmails,
                                )}
                              </span>
                            ) : null}
                            {account.detail ? (
                              <span className="shrink-0 text-muted-foreground/60">
                                · {account.detail}
                              </span>
                            ) : null}
                            {(account.isCurrent || account.isNext === true) &&
                            providerUsageAccounts.length > 1 ? (
                              <span className="shrink-0 self-center rounded-full border border-border/60 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
                                {/* One badge per row: a current account is next
                                    for its own session by definition. */}
                                {account.isCurrent ? "current" : "next"}
                              </span>
                            ) : null}
                          </span>
                          {stale && !props.providerUsageRefreshing ? (
                            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                              {formatProviderUsageAge(account.observedAt, nowMs)}
                            </span>
                          ) : null}
                        </div>
                        {account.error ? (
                          <div className="text-[11px] text-destructive/90">{account.error}</div>
                        ) : null}
                        {account.usage && account.usage.windows.length > 0 ? (
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
                    </Fragment>
                  );
                })}
              </div>
            ) : null}

            {props.openRouterCredits ? (
              <>
                {providerUsage || providerUsageAccounts.length > 0 ? (
                  <div className="h-px w-full shrink-0 bg-border/60" />
                ) : null}
                <div className="flex shrink-0 flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-muted-foreground text-xs">
                      OpenRouter credits
                    </span>
                    {props.openRouterCredits.balanceUsd !== null ? (
                      <span
                        className={cn(
                          "text-[11px] font-medium tabular-nums text-muted-foreground/90",
                          (props.openRouterCredits.unavailable ||
                            isProviderUsageSnapshotStale(
                              props.openRouterCredits.observedAt,
                              nowMs,
                            )) &&
                            "opacity-55",
                        )}
                      >
                        {formatUsd(props.openRouterCredits.balanceUsd)} left
                      </span>
                    ) : null}
                  </div>
                  {/* An error outranks the add-a-key hint: an unreadable
                      secret store also reports unconfigured, and "add your
                      key" would be the wrong remedy for it. */}
                  {props.openRouterCredits.unavailable ? (
                    <div className="text-[11px] text-muted-foreground/60">
                      Couldn't load the latest balance.
                    </div>
                  ) : props.openRouterCredits.error !== null ? (
                    <div className="text-[11px] text-destructive/90">
                      {props.openRouterCredits.error}
                    </div>
                  ) : !props.openRouterCredits.configured ? (
                    <div className="text-[11px] text-muted-foreground/60">
                      Add your OpenRouter management key in Settings → Extras.
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            {(providerUsage || providerUsageAccounts.length > 0 || props.openRouterCredits) &&
            usage ? (
              <div className="h-px w-full shrink-0 bg-border/60" />
            ) : null}

            {usage ? (
              <div className="flex shrink-0 flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium text-muted-foreground text-xs">Context Window</div>
                  {usage.maxTokens !== null && usedPercentage !== null ? (
                    <div className="text-secondary-label text-[11px] tabular-nums">
                      <span>{usedPercentage}</span>
                      <span className="mx-1">·</span>
                      <span>
                        {formatContextWindowTokens(usage.usedTokens)}/
                        {formatContextWindowTokens(usage.maxTokens ?? null)}
                      </span>
                    </div>
                  ) : (
                    <div className="text-secondary-label text-[11px] tabular-nums">
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
                    <span className="text-secondary-label">Total processed</span>
                    <span className="font-medium tabular-nums text-secondary-label">
                      {formatContextWindowTokens(totalProcessedTokens)}
                    </span>
                  </div>
                ) : null}
                {usage.compactsAutomatically ? (
                  <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">
                    {formatContextWindowCompactionMessage(
                      modelDisplayName,
                      usage.autoCompactThreshold,
                    )}
                  </div>
                ) : null}
                {onCompact ? (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      className="mt-1 w-full justify-center"
                      disabled={compactDisabled}
                      onClick={onCompact}
                    >
                      <Minimize2Icon aria-hidden="true" />
                      Compact context
                    </Button>
                    {compactDisabled && compactDisabledReason ? (
                      <div className="text-pretty text-secondary-label text-[11px]">
                        {compactDisabledReason}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
