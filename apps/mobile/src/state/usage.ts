/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * Mirror of `apps/web/src/state/usage.ts` over mobile's atom wiring; the merge
 * rules themselves live in `@t3tools/shared/usageMerge`.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { needsCursorKeychainAccess, refreshUsage } from "@t3tools/client-runtime/state/usage";
import { resolveUsageAccess } from "@t3tools/client-runtime/state/usage-access";
import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import {
  classifyEnvironmentUsage,
  usageProgress,
  type EnvironmentUsageState,
} from "../lib/usageCoverage";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentSession, readEnvironmentScope } from "./session";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly queryPending: boolean;
  readonly state: EnvironmentUsageState;
  /** Whether this connection holds the diagnostics grant usage needs. */
  readonly canReadDiagnostics: boolean;
  /**
   * Why a `failed` environment cannot report: a denied grant or a failed
   * access check need different fixes than a failed scan. Null otherwise.
   */
  readonly accessError: string | null;
  readonly needsCursorKeychainAccess: boolean;
}

/**
 * Reads every environment's summary for one window.
 *
 * Keyed by the serialised window so switching ranges does not thrash the atom
 * cache, and so each environment's query is shared with any other reader of the
 * same window.
 */
const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const session = Option.getOrNull(AsyncResult.value(sessionResult));
      const hasSessionError = sessionResult._tag === "Failure";
      const access = resolveUsageAccess({
        connectionPhase: presentation.connection.phase,
        session,
        hasSessionError,
      });
      if (!access.canReadDiagnostics) {
        // Map upstream's access check onto the fork's coverage states: a check
        // still running is reporting, an offline connection that never
        // prepared a session is unreachable, and a denial or failed check is
        // a terminal failure carrying its reason.
        const state: EnvironmentUsageState = access.isPending
          ? { kind: "reporting" }
          : session === null && !hasSessionError
            ? { kind: "unreachable" }
            : { kind: "failed" };
        statuses.push({
          environmentId,
          label: presentation.entry.target.label,
          queryPending: false,
          state,
          canReadDiagnostics: false,
          accessError: state.kind === "failed" ? access.error : null,
          needsCursorKeychainAccess: false,
        });
        continue;
      }
      const result = get(serverEnvironment.usageSummary({ environmentId, input }));
      const summary = Option.getOrNull(AsyncResult.value(result));
      const state = classifyEnvironmentUsage({
        phase: presentation.connection.phase,
        failed: result._tag === "Failure",
        summary,
      });
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        queryPending: result.waiting,
        state,
        canReadDiagnostics: true,
        accessError: null,
        needsCursorKeychainAccess: needsCursorKeychainAccess(
          state.kind === "reported" ? state.summary : null,
          get(serverEnvironment.providersValueAtom(environmentId)),
        ),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`mobile-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that can still answer are answering. Failed and
   * unreachable environments are terminal and reported through coverage rows:
   * totals will not improve by waiting on them, so they must not read as
   * "still reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: (input?: UsageSummaryInput) => Promise<void>;
}

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
): UsageView {
  const windowKey = useMemo(
    () =>
      JSON.stringify({
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        timeZone: input.timeZone,
        resolution: input.resolution,
        sinceTime: input.sinceTime,
        untilTime: input.untilTime,
      }),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
    ],
  );
  const atom = usageByWindowAtom(windowKey);
  const environments = useAtomValue(atom);
  const selectedEnvironments = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? environments
        : environments.filter(({ environmentId }) => selectedEnvironmentIds.has(environmentId)),
    [environments, selectedEnvironmentIds],
  );

  // The shared helper refetches model pricing, then rescans each selected
  // environment's transcripts, so a model released since the last daily fetch
  // gets priced by the rescan.
  const refresh = useCallback(
    (nextInput?: UsageSummaryInput) => {
      const environmentIds = selectedEnvironments.map(({ environmentId }) => environmentId);
      // The Limits section on the same screen reads provider quota snapshots,
      // which the transcript rescan never touches (web refreshes them
      // explicitly on its Limits tab).
      for (const environmentId of environmentIds) {
        void runAtomCommand(
          appAtomRegistry,
          serverEnvironment.refreshProviders,
          { environmentId, input: {} },
          { reportFailure: false },
        );
      }
      return refreshUsage({
        registry: appAtomRegistry,
        server: serverEnvironment,
        presentations: environmentPresentations,
        // Only environments this connection may read; the others report a
        // permission error instead of a stale or failed rescan.
        environmentIds: selectedEnvironments
          .filter(
            (environment) =>
              environment.canReadDiagnostics &&
              readEnvironmentScope(environment.environmentId, AuthDiagnosticsReadScope),
          )
          .map(({ environmentId }) => environmentId),
        input: nextInput ?? (JSON.parse(windowKey) as UsageSummaryInput),
      });
    },
    [selectedEnvironments, windowKey],
  );

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = selectedEnvironments.flatMap((environment) =>
      environment.state.kind === "reported"
        ? [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary: environment.state.summary,
            },
          ]
        : [],
    );
    return mergeUsage(answered, USAGE_CONTRACT_VERSION);
  }, [selectedEnvironments]);

  const progress = usageProgress(selectedEnvironments.map((environment) => environment.state));

  return {
    merged,
    environments,
    selectedEnvironments,
    isPending: progress.isPending,
    isPartial: progress.isPartial,
    refresh,
  };
}
