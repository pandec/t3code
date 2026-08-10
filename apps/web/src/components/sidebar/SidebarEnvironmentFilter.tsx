import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { LayersIcon, MonitorIcon, ServerIcon } from "lucide-react";
import { memo, type ReactElement } from "react";

import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "~/components/ConnectionStatusDot";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { SidebarMenuButton } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/**
 * Structurally identical to `SidebarEnvironmentScope` in `Sidebar.logic.ts`.
 * Declared locally so this component stays importable on its own; the caller's
 * scope type assigns to it without a cast.
 */
export type SidebarEnvironmentFilterScope = ReadonlySet<string> | null;

export interface SidebarEnvironmentFilterEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly isPrimary: boolean;
  /** Live non-archived threads that the project scope and hidden projects
   *  already admit, counted before the environment filter runs so the numbers
   *  stay stable while you narrow the selection. Only knowable while the
   *  environment is connected — see `isEnvironmentConnected`. */
  readonly threadCount: number;
}

export interface SidebarEnvironmentFilterMenuProps {
  /** Pre-sorted by the caller (primary first, then alphabetical). Rendered as given. */
  readonly environments: readonly SidebarEnvironmentFilterEnvironment[];
  /** Raw intent, not the resolved set: a filter whose environments are all
   *  offline must still read as active, or it cannot be cleared. */
  readonly scope: SidebarEnvironmentFilterScope;
  readonly onToggleEnvironment: (environmentId: string) => void;
  readonly onSelectAll: () => void;
  readonly onSelectPrimaryOnly: () => void;
  readonly onSelectRemoteOnly: () => void;
}

/** Shared with the project scope menu so both filters sit on the same grid. */
const MENU_ROW_CLASS_NAME =
  "h-8 min-h-8 py-0 ps-1 pe-1 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2";

/** Quick actions are plain items; the leading spacer keeps their icon on the
 *  same column as the checkbox rows' icons. */
const MENU_ACTION_CLASS_NAME = "h-8 min-h-8 py-0 ps-1 pe-1 text-sm font-medium";

/** Past this many, the trigger summary counts environments instead of naming them. */
const MAX_NAMED_ENVIRONMENTS_IN_SUMMARY = 3;

function environmentCountLabel(count: number): string {
  return `${count} ${count === 1 ? "environment" : "environments"}`;
}

function threadCountLabel(count: number): string {
  return `${count} ${count === 1 ? "thread" : "threads"}`;
}

/**
 * Only a connected environment can report its threads. Every other phase means
 * we cannot see them, which is not the same as there being none — the copy in
 * this file must never conflate the two.
 */
function isEnvironmentConnected(environment: SidebarEnvironmentFilterEnvironment): boolean {
  return environment.connection.phase === "connected";
}

/**
 * Tooltip / aria summary of the selection: names while they fit, counts once
 * they do not, plus a tail for selected ids that have left the catalog so a
 * partly-stale filter never passes as fully live.
 */
function summarizeEnvironmentScope(
  selectedEnvironments: readonly SidebarEnvironmentFilterEnvironment[],
  unavailableCount: number,
): string {
  const parts =
    selectedEnvironments.length > MAX_NAMED_ENVIRONMENTS_IN_SUMMARY
      ? [environmentCountLabel(selectedEnvironments.length)]
      : selectedEnvironments.map((environment) => environment.label);
  if (unavailableCount > 0) {
    parts.push(`${environmentCountLabel(unavailableCount)} unavailable`);
  }
  return parts.join(", ");
}

function SidebarEnvironmentFilterMenuImpl({
  environments,
  scope,
  onToggleEnvironment,
  onSelectAll,
  onSelectPrimaryOnly,
  onSelectRemoteOnly,
}: SidebarEnvironmentFilterMenuProps): ReactElement | null {
  // A lone environment cannot be filtered against anything, but an active scope
  // still needs its own way out — keep the trigger while one is set. Bailing
  // first keeps that setup from doing the summary work below and discarding it.
  if (environments.length < 2 && scope === null) {
    return null;
  }

  const selectedEnvironments =
    scope === null
      ? []
      : environments.filter((environment) => scope.has(environment.environmentId));
  // Derived here rather than accepted as a prop: the parent can only compute it
  // from a different array, and the two would agree by coincidence.
  const unavailableCount = scope === null ? 0 : scope.size - selectedEnvironments.length;
  const scopeSummary =
    scope === null
      ? "All environments"
      : summarizeEnvironmentScope(selectedEnvironments, unavailableCount);
  const hasPrimaryEnvironment = environments.some((environment) => environment.isPrimary);
  const hasRemoteEnvironment = environments.some((environment) => !environment.isPrimary);

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <SidebarMenuButton
                  size="icon"
                  type="button"
                  isActive={scope !== null}
                  aria-pressed={scope !== null}
                  aria-label={`Filter threads by environment — ${scopeSummary}`}
                  data-testid="sidebar-v2-environment-filter-trigger"
                  // overflow-visible lets the count badge sit on the corner;
                  // the button clips its children by default.
                  className="relative shrink-0 overflow-visible focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                />
              }
            />
          }
        >
          <ServerIcon />
          {/* Counts environments that still exist rather than raw selected ids:
              a badge of 2 where one id has left the catalog would promise a
              breadth the filter no longer has. A single selection needs no
              badge — the active state already carries it. */}
          {selectedEnvironments.length > 1 ? (
            <span
              aria-hidden
              className="pointer-events-none absolute -top-0.5 -right-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground ring-1 ring-sidebar tabular-nums"
            >
              {selectedEnvironments.length}
            </span>
          ) : null}
          <span
            className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
            aria-hidden="true"
          />
        </TooltipTrigger>
        <TooltipPopup side="right">
          {scope === null ? "Filter threads by environment" : scopeSummary}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="w-64">
        <MenuCheckboxItem
          checked={scope === null}
          closeOnClick
          onCheckedChange={onSelectAll}
          className={MENU_ROW_CLASS_NAME}
          data-testid="sidebar-v2-environment-filter-all"
        >
          <LayersIcon className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 truncate text-sm">All environments</span>
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuItem
          className={MENU_ACTION_CLASS_NAME}
          disabled={!hasPrimaryEnvironment}
          onClick={onSelectPrimaryOnly}
          data-testid="sidebar-v2-environment-filter-primary-only"
        >
          <span aria-hidden className="size-4 shrink-0" />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <MonitorIcon className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 truncate text-sm">This environment only</span>
          </span>
        </MenuItem>
        <MenuItem
          className={MENU_ACTION_CLASS_NAME}
          disabled={!hasRemoteEnvironment}
          onClick={onSelectRemoteOnly}
          data-testid="sidebar-v2-environment-filter-remote-only"
        >
          <span aria-hidden className="size-4 shrink-0" />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <ServerIcon className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 truncate text-sm">Remote environments only</span>
          </span>
        </MenuItem>
        <MenuSeparator />
        {environments.map((environment) => {
          const statusText = connectionStatusText(environment.connection);
          // The thread card already uses ServerIcon to mean "not this machine".
          // Splitting Monitor/Server here teaches the same reading instead of
          // contradicting it.
          const EnvironmentIcon = environment.isPrimary ? MonitorIcon : ServerIcon;
          return (
            <MenuCheckboxItem
              key={environment.environmentId}
              checked={scope?.has(environment.environmentId) ?? false}
              onCheckedChange={() => onToggleEnvironment(environment.environmentId)}
              className={MENU_ROW_CLASS_NAME}
              data-testid={`sidebar-v2-environment-filter-option-${environment.environmentId}`}
            >
              <EnvironmentIcon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm">
                {environment.label}
                {environment.isPrimary ? (
                  <span className="ms-1.5 text-xs font-normal text-muted-foreground">
                    This device
                  </span>
                ) : null}
              </span>
              <ConnectionStatusDot
                tooltipText={statusText}
                dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                pingClassName={connectionPhasePingClassName(environment.connection.phase)}
              />
              {/* The count is only knowledge while the environment is connected.
                  Blank defers to the dot, which already explains why; a
                  confident 0 would assert something we cannot see. */}
              {isEnvironmentConnected(environment) ? (
                <>
                  <span
                    aria-hidden
                    className="shrink-0 text-xs text-muted-foreground/70 tabular-nums"
                  >
                    {environment.threadCount}
                  </span>
                  <span className="sr-only">{threadCountLabel(environment.threadCount)}</span>
                </>
              ) : null}
            </MenuCheckboxItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

export const SidebarEnvironmentFilterMenu = memo(SidebarEnvironmentFilterMenuImpl);

/**
 * Sidebar empty-state line for a list emptied by the environment filter.
 * Returns null when the environment filter cannot be the reason.
 */
export function resolveSidebarEnvironmentEmptyStateLabel(input: {
  readonly environments: readonly SidebarEnvironmentFilterEnvironment[];
  readonly scope: SidebarEnvironmentFilterScope;
  /** True when a project scope or hidden projects are ALSO narrowing the list. */
  readonly otherFiltersNarrowing: boolean;
}): string | null {
  const { environments, scope, otherFiltersNarrowing } = input;
  // Another filter is cutting the list down too, so this one cannot claim to be
  // the reason it came out empty — and the "Show all environments" button beside
  // this message would clear the wrong thing.
  if (scope === null || otherFiltersNarrowing) {
    return null;
  }

  const selectedEnvironments = environments.filter((environment) =>
    scope.has(environment.environmentId),
  );
  const connectedEnvironments = selectedEnvironments.filter(isEnvironmentConnected);
  // Gone from the catalog and merely asleep are different situations for the
  // user, so they get different sentences.
  const removedCount = scope.size - selectedEnvironments.length;
  const disconnectedCount = selectedEnvironments.length - connectedEnvironments.length;

  if (connectedEnvironments.length === 0) {
    const [onlySelected] = selectedEnvironments;
    if (disconnectedCount === 0) {
      return scope.size === 1
        ? "The selected environment is unavailable"
        : "The selected environments are unavailable";
    }
    if (removedCount > 0) {
      // Part removed, part merely offline: "unavailable" is the only claim true
      // of both.
      return "The selected environments are unavailable";
    }
    return onlySelected !== undefined && selectedEnvironments.length === 1
      ? `${onlySelected.label} is disconnected`
      : "The selected environments are disconnected";
  }

  const [onlyConnected] = connectedEnvironments;
  const emptyLabel =
    onlyConnected !== undefined && connectedEnvironments.length === 1
      ? `No threads on ${onlyConnected.label} yet`
      : "No threads on the selected environments yet";
  // Naming one environment while silently dropping the rest of the selection
  // would misrepresent the filter, so the shortfall is stated.
  const unreachableCount = removedCount + disconnectedCount;
  return unreachableCount === 0
    ? emptyLabel
    : `${emptyLabel} · ${environmentCountLabel(unreachableCount)} unavailable`;
}
