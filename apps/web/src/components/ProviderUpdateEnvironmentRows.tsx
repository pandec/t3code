import { CheckIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useLocalEnvironmentUpdateGroups } from "./ProviderUpdateLaunchNotification.environments";
import {
  collectProviderUpdateOutcomeSnapshots,
  firstRejectedProviderUpdateMessage,
  getProviderUpdateProgressToastView,
  getProviderUpdateRejectedToastView,
  getProviderUpdateSidebarPillView,
  isTerminalProviderUpdatePhase,
  resolveEnvironmentUpdateRowStatus,
  type LocalEnvironmentUpdateGroup,
  type LocalProviderUpdateOutcome,
  type ProviderUpdateRowStatus,
  type ProviderUpdateRowStatusKind,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

type ProviderUpdateCommandResult = AtomCommandResult<
  { readonly providers: ReadonlyArray<ServerProvider> },
  unknown
>;

interface ProviderUpdateDispatchOutcome {
  readonly result: PromiseSettledResult<LocalProviderUpdateOutcome>;
  readonly interrupted: boolean;
}

/**
 * Map one targeted instance's update command result into the settled-outcome
 * shape the multi-backend reducers consume. The interruption flag stays separate
 * so a dispatch with no terminal snapshot can still show a retryable result.
 */
function toProviderUpdateOutcome(input: {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
  readonly target: {
    readonly driver: ServerProvider["driver"];
    readonly instanceId: ServerProvider["instanceId"];
  };
  readonly result: ProviderUpdateCommandResult;
}): ProviderUpdateDispatchOutcome {
  if (input.result._tag === "Failure") {
    if (isAtomCommandInterrupted(input.result)) {
      return {
        interrupted: true,
        result: {
          status: "fulfilled",
          value: {
            environmentId: input.environmentId,
            isPrimary: input.isPrimary,
            driver: input.target.driver,
            instanceId: input.target.instanceId,
            provider: null,
          },
        },
      };
    }
    const error = squashAtomCommandFailure(input.result);
    return {
      interrupted: false,
      result: {
        status: "rejected",
        reason: error instanceof Error ? error : new Error("Provider update failed."),
      },
    };
  }

  const provider =
    input.result.value.providers.find(
      (candidate) => candidate.instanceId === input.target.instanceId,
    ) ?? null;
  return {
    interrupted: false,
    result: {
      status: "fulfilled",
      value: {
        environmentId: input.environmentId,
        isPrimary: input.isPrimary,
        driver: input.target.driver,
        instanceId: input.target.instanceId,
        provider,
      },
    },
  };
}

// Transport-hang safety net. The dispatch's `finally` clears the spinner and the
// in-flight guard on completion, so this only matters if a request never resolves
// at all (e.g. the socket drops mid-flight without surfacing an error). Keep it
// well beyond the server's own update timeout (5 min) so a legitimately slow
// update (npm installs routinely run tens of seconds) is never cut off and left
// showing a dead, unresponsive Update button.
const PENDING_EXPIRY_MS = 6 * 60_000;
const UPDATE_INTERRUPTED_MESSAGE = "Provider update was interrupted. Try again.";
const UPDATE_TIMED_OUT_MESSAGE = "Update timed out. Try again.";

export interface ProviderUpdateResultClaim {
  readonly environmentId: EnvironmentId;
  readonly generation: number;
  readonly providerInstanceIds: ReadonlySet<ServerProvider["instanceId"]>;
  readonly providerCount: number;
  readonly startedAfterIso: string;
}

interface ActiveProviderUpdateResultClaim extends ProviderUpdateResultClaim {
  readonly timeout: ReturnType<typeof setTimeout>;
}

function isProviderUpdateSnapshotAfter(provider: ServerProvider, startedAfterIso: string): boolean {
  const state = provider.updateState;
  if (state?.startedAt === null || state?.startedAt === undefined) {
    return false;
  }
  if (state.startedAt < startedAfterIso) {
    return false;
  }
  if (state.status === "failed" || state.status === "succeeded" || state.status === "unchanged") {
    return state.finishedAt !== null && state.finishedAt >= startedAfterIso;
  }
  return state.finishedAt === null || state.finishedAt >= startedAfterIso;
}

function getTerminalProviderUpdateView(
  groups: ReadonlyArray<LocalEnvironmentUpdateGroup>,
  claim: ProviderUpdateResultClaim,
): ProviderUpdateToastView | null {
  const group = groups.find((candidate) => candidate.environmentId === claim.environmentId);
  if (!group) {
    return null;
  }
  const providers = group.providers.filter(
    (provider) =>
      claim.providerInstanceIds.has(provider.instanceId) &&
      isProviderUpdateSnapshotAfter(provider, claim.startedAfterIso),
  );
  const view = getProviderUpdateProgressToastView({
    providers,
    providerCount: claim.providerCount,
  });
  return isTerminalProviderUpdatePhase(view.phase) ? view : null;
}

/**
 * Keep terminal-result claims in the notification host so dismissing the
 * popover cannot discard an in-flight update's result. The row still owns all
 * visible progress while the popover remains open.
 */
export function createProviderUpdateResultDelivery(input: {
  readonly isPopoverOpen: () => boolean;
  readonly onResult: (view: ProviderUpdateToastView) => void;
}) {
  const activeUpdates = new Map<EnvironmentId, ActiveProviderUpdateResultClaim>();
  let latestGroups: ReadonlyArray<LocalEnvironmentUpdateGroup> = [];

  const finishUpdate = (
    environmentId: EnvironmentId,
    generation: number,
    view: ProviderUpdateToastView,
  ): boolean => {
    const activeUpdate = activeUpdates.get(environmentId);
    if (activeUpdate && activeUpdate.generation !== generation) {
      return false;
    }
    const timeout = activeUpdate?.timeout;
    if (!activeUpdates.delete(environmentId)) {
      return false;
    }
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (!input.isPopoverOpen()) {
      input.onResult(view);
    }
    return true;
  };

  const startUpdate = (claim: ProviderUpdateResultClaim): void => {
    const previous = activeUpdates.get(claim.environmentId);
    if (previous) {
      clearTimeout(previous.timeout);
    }
    const timeout = setTimeout(() => {
      const liveView = getTerminalProviderUpdateView(latestGroups, claim);
      finishUpdate(
        claim.environmentId,
        claim.generation,
        liveView ??
          getProviderUpdateRejectedToastView(claim.providerCount, UPDATE_TIMED_OUT_MESSAGE),
      );
    }, PENDING_EXPIRY_MS);
    activeUpdates.set(claim.environmentId, { ...claim, timeout });
  };

  const observeGroups = (groups: ReadonlyArray<LocalEnvironmentUpdateGroup>): void => {
    latestGroups = groups;
    for (const claim of activeUpdates.values()) {
      const view = getTerminalProviderUpdateView(groups, claim);
      if (view) {
        finishUpdate(claim.environmentId, claim.generation, view);
      }
    }
  };

  const dispose = (): void => {
    for (const claim of activeUpdates.values()) {
      clearTimeout(claim.timeout);
    }
    activeUpdates.clear();
  };

  return { dispose, finishUpdate, observeGroups, startUpdate };
}

function rowToneClass(kind: ProviderUpdateRowStatusKind): string {
  switch (kind) {
    case "failed":
      return "text-destructive";
    case "unchanged":
      return "text-warning";
    case "success":
      return "text-success";
    default:
      return "text-muted-foreground";
  }
}

function EnvironmentUpdateRow({
  group,
  status,
  onUpdate,
}: {
  readonly group: LocalEnvironmentUpdateGroup;
  readonly status: ProviderUpdateRowStatus;
  readonly onUpdate: () => void;
}) {
  let trailing: ReactNode;
  switch (status.kind) {
    case "loading":
      trailing = <Spinner className="size-4 text-muted-foreground" />;
      break;
    case "success":
      trailing = <CheckIcon aria-hidden="true" className="size-4 text-success" />;
      break;
    case "failed":
    case "unchanged":
      trailing = (
        <Button size="xs" variant="outline" onClick={onUpdate}>
          Retry
        </Button>
      );
      break;
    default:
      trailing = (
        <Button size="xs" onClick={onUpdate}>
          Update
        </Button>
      );
      break;
  }

  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">{group.label}</span>
        <span className={cn("truncate text-xs", rowToneClass(status.kind))}>{status.text}</span>
      </div>
      <div className="shrink-0">{trailing}</div>
    </div>
  );
}

/**
 * The launch popover's body when WSL is present: one row per local environment
 * (Windows + WSL), each with its own "update all" trigger that targets only
 * that environment's backend.
 */
export function ProviderUpdateEnvironmentRows({
  onInteract,
  onUpdateFinished,
  onUpdateStarted,
}: {
  /** Called when the user triggers an update, so the host keeps this popover open. */
  readonly onInteract?: () => void;
  /** Hands terminal command results to the host-owned exactly-once claim. */
  readonly onUpdateFinished?: (
    environmentId: EnvironmentId,
    generation: number,
    view: ProviderUpdateToastView,
  ) => void;
  /** Registers result delivery before dispatching an environment's updates. */
  readonly onUpdateStarted?: (claim: ProviderUpdateResultClaim) => void;
}) {
  const { groups } = useLocalEnvironmentUpdateGroups();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const groupByEnvironment = useMemo(
    () => new Map(groups.map((group) => [group.environmentId, group] as const)),
    [groups],
  );
  const latestGroupsRef = useRef(groups);
  latestGroupsRef.current = groups;

  // Before an environment is updated, ignore terminal state from before this
  // popover opened. Once dispatched, use that attempt's start time instead.
  const popoverOpenedAfterIsoRef = useRef<string>(new Date().toISOString());
  const visibleAfterIsoByEnvironmentRef = useRef<Map<EnvironmentId, string>>(new Map());
  const trackedProviderIdsByEnvironmentRef = useRef<
    Map<EnvironmentId, ReadonlySet<ServerProvider["instanceId"]>>
  >(new Map());

  // Synchronous re-entry guard. setPendingEnvironments is an async state update,
  // and PENDING_EXPIRY_MS can clear the spinner while a request is still in
  // flight, so a rapid double-click (or a click after the expiry fires mid-
  // request) would otherwise dispatch a second full round of updates. A ref
  // updates synchronously, so we can bail before doing any work.
  const inFlightEnvironmentsRef = useRef<Set<EnvironmentId>>(new Set());

  // Monotonic per-environment request version. Bumped on each dispatch and
  // captured locally, so an attempt that was superseded -- e.g. one that already
  // tripped the expiry safety net and was retried -- detects it is no longer
  // current and skips every state write when it finally resolves, instead of
  // clobbering the newer attempt's spinner/result/error or its in-flight guard.
  const requestVersionRef = useRef<Map<EnvironmentId, number>>(new Map());

  const [pendingEnvironments, setPendingEnvironments] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(),
  );
  const [errorByEnvironment, setErrorByEnvironment] = useState<ReadonlyMap<EnvironmentId, string>>(
    () => new Map(),
  );
  const [resultByEnvironment, setResultByEnvironment] = useState<
    ReadonlyMap<EnvironmentId, ProviderUpdateToastView>
  >(() => new Map());

  const clearPending = useCallback((environmentId: EnvironmentId) => {
    setPendingEnvironments((previous) => {
      if (!previous.has(environmentId)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(environmentId);
      return next;
    });
  }, []);

  const handleUpdate = useCallback(
    async (environmentId: EnvironmentId) => {
      const group = groupByEnvironment.get(environmentId);
      if (!group || group.candidates.length === 0) {
        return;
      }
      if (inFlightEnvironmentsRef.current.has(environmentId)) {
        return;
      }
      inFlightEnvironmentsRef.current.add(environmentId);
      const requestVersion = (requestVersionRef.current.get(environmentId) ?? 0) + 1;
      requestVersionRef.current.set(environmentId, requestVersion);
      const isCurrentRequest = () =>
        requestVersionRef.current.get(environmentId) === requestVersion;
      const startedAfterIso = new Date().toISOString();
      visibleAfterIsoByEnvironmentRef.current.set(environmentId, startedAfterIso);
      onInteract?.();
      const providerCount = group.candidates.length;
      const targets = group.candidates.map((candidate) => ({
        driver: candidate.driver,
        instanceId: candidate.instanceId,
      }));
      const providerInstanceIds = new Set(targets.map((target) => target.instanceId));
      trackedProviderIdsByEnvironmentRef.current.set(environmentId, providerInstanceIds);
      onUpdateStarted?.({
        environmentId,
        generation: requestVersion,
        providerCount,
        providerInstanceIds,
        startedAfterIso,
      });

      setPendingEnvironments((previous) => new Set(previous).add(environmentId));
      setErrorByEnvironment((previous) => {
        if (!previous.has(environmentId)) {
          return previous;
        }
        const next = new Map(previous);
        next.delete(environmentId);
        return next;
      });
      setResultByEnvironment((previous) => {
        if (!previous.has(environmentId)) {
          return previous;
        }
        const next = new Map(previous);
        next.delete(environmentId);
        return next;
      });

      const expiry = setTimeout(() => {
        // A newer attempt may have superseded this one; if so, leave its state
        // untouched.
        if (!isCurrentRequest()) {
          return;
        }
        // The request is presumed dead (see PENDING_EXPIRY_MS). Clear the
        // spinner AND the in-flight guard together so the row never strands on a
        // dead Update button, and surface feedback so the timeout is visible
        // rather than silently reverting to idle.
        inFlightEnvironmentsRef.current.delete(environmentId);
        clearPending(environmentId);
        const liveView = getTerminalProviderUpdateView(latestGroupsRef.current, {
          environmentId,
          generation: requestVersion,
          providerCount,
          providerInstanceIds,
          startedAfterIso,
        });
        if (liveView) {
          setResultByEnvironment((previous) => new Map(previous).set(environmentId, liveView));
          onUpdateFinished?.(environmentId, requestVersion, liveView);
          return;
        }
        setErrorByEnvironment((previous) =>
          new Map(previous).set(environmentId, UPDATE_TIMED_OUT_MESSAGE),
        );
        onUpdateFinished?.(
          environmentId,
          requestVersion,
          getProviderUpdateRejectedToastView(providerCount, UPDATE_TIMED_OUT_MESSAGE),
        );
      }, PENDING_EXPIRY_MS);
      try {
        // Dispatch each candidate's update to this environment's own backend and
        // normalize every settled outcome into the multi-backend reducer shape.
        const dispatchOutcomes = await Promise.all(
          targets.map(async (target): Promise<ProviderUpdateDispatchOutcome> => {
            try {
              const result = await updateProvider({
                environmentId,
                input: { provider: target.driver, instanceId: target.instanceId },
              });
              return toProviderUpdateOutcome({
                environmentId,
                isPrimary: group.isPrimary,
                target,
                result,
              });
            } catch (error) {
              return {
                interrupted: false,
                result: {
                  status: "rejected",
                  reason: error instanceof Error ? error : new Error("Provider update failed."),
                },
              };
            }
          }),
        );
        if (!isCurrentRequest()) {
          // A newer attempt superseded this one while it was in flight; leave
          // the newer attempt's state intact.
          return;
        }
        // The request resolved (not a transport hang), so clear any stale
        // timeout error the expiry may have set -- otherwise a late success
        // would be masked, since an error takes priority in the row status.
        setErrorByEnvironment((previous) => {
          if (!previous.has(environmentId)) {
            return previous;
          }
          const next = new Map(previous);
          next.delete(environmentId);
          return next;
        });
        const results = dispatchOutcomes.map((outcome) => outcome.result);
        const rejectedMessage = firstRejectedProviderUpdateMessage(results);
        if (rejectedMessage) {
          const view = getProviderUpdateRejectedToastView(providerCount, rejectedMessage);
          setErrorByEnvironment((previous) =>
            new Map(previous).set(environmentId, rejectedMessage),
          );
          onUpdateFinished?.(environmentId, requestVersion, view);
          return;
        }
        const view = getProviderUpdateProgressToastView({
          providers: collectProviderUpdateOutcomeSnapshots(results).filter((provider) =>
            isProviderUpdateSnapshotAfter(provider, startedAfterIso),
          ),
          providerCount,
        });
        // Only persist a terminal outcome. A non-terminal snapshot never
        // re-polls, so the live environment state must finish the row instead.
        if (isTerminalProviderUpdatePhase(view.phase)) {
          setResultByEnvironment((previous) => new Map(previous).set(environmentId, view));
          onUpdateFinished?.(environmentId, requestVersion, view);
          return;
        }
        if (dispatchOutcomes.some((outcome) => outcome.interrupted)) {
          const interruptedView = getProviderUpdateRejectedToastView(
            providerCount,
            UPDATE_INTERRUPTED_MESSAGE,
          );
          setErrorByEnvironment((previous) =>
            new Map(previous).set(environmentId, UPDATE_INTERRUPTED_MESSAGE),
          );
          onUpdateFinished?.(environmentId, requestVersion, interruptedView);
        }
      } catch (error) {
        if (isCurrentRequest()) {
          const message = error instanceof Error ? error.message : "Provider update failed.";
          setErrorByEnvironment((previous) => new Map(previous).set(environmentId, message));
          onUpdateFinished?.(
            environmentId,
            requestVersion,
            getProviderUpdateRejectedToastView(providerCount, message),
          );
        }
      } finally {
        clearTimeout(expiry);
        // Only the current attempt owns the shared spinner and in-flight guard;
        // a superseded attempt resolving late must not clear a newer one's.
        if (isCurrentRequest()) {
          clearPending(environmentId);
          inFlightEnvironmentsRef.current.delete(environmentId);
        }
      }
    },
    [
      clearPending,
      groupByEnvironment,
      onInteract,
      onUpdateFinished,
      onUpdateStarted,
      updateProvider,
    ],
  );

  const rows = groups
    .map((group) => {
      const trackedProviderIds = trackedProviderIdsByEnvironmentRef.current.get(
        group.environmentId,
      );
      const visibleAfterIso =
        visibleAfterIsoByEnvironmentRef.current.get(group.environmentId) ??
        popoverOpenedAfterIsoRef.current;
      const liveProviders = trackedProviderIds
        ? group.providers.filter(
            (provider) =>
              trackedProviderIds.has(provider.instanceId) &&
              isProviderUpdateSnapshotAfter(provider, visibleAfterIso),
          )
        : group.candidates;
      return {
        group,
        status: resolveEnvironmentUpdateRowStatus({
          group,
          error: errorByEnvironment.get(group.environmentId),
          result: resultByEnvironment.get(group.environmentId),
          // Before dispatch, only candidates can contribute state. Afterward,
          // keep tracking those instance ids even when a successful update
          // removes them from the candidate set.
          pill: getProviderUpdateSidebarPillView(liveProviders, { visibleAfterIso }),
          isPending: pendingEnvironments.has(group.environmentId),
        }),
      };
    })
    .filter(({ group, status }) => group.candidates.length > 0 || status.kind !== "idle");

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="mt-0.5 flex flex-col gap-1">
      {rows.map(({ group, status }) => (
        <EnvironmentUpdateRow
          key={group.environmentId}
          group={group}
          status={status}
          onUpdate={() => handleUpdate(group.environmentId)}
        />
      ))}
    </div>
  );
}
