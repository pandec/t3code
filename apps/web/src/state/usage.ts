/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  mergeUsage,
  type EnvironmentUsage,
  type MergedUsage,
  type UsageAttribution,
} from "@t3tools/shared/usageMerge";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  classifyEnvironmentUsage,
  usageProgress,
  type EnvironmentUsageState,
} from "../usage/usageCoverage";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
  /** Rich coverage classification layered over upstream's progressive status fields. */
  readonly state?: EnvironmentUsageState;
}

function environmentUsageState(environment: EnvironmentUsageStatus): EnvironmentUsageState {
  if (environment.state !== undefined) return environment.state;
  if (environment.summary !== null) return { kind: "reported", summary: environment.summary };
  return environment.error === null ? { kind: "reporting" } : { kind: "failed" };
}

/**
 * Reads every environment's summary for one window.
 *
 * Keyed by the serialised window so switching ranges does not thrash the atom
 * cache, and so each environment's query is shared with any other reader of the
 * same window.
 *
 * The query atom for an environment that has never connected stays pending
 * forever (it waits for a connection that is not coming), so the connection
 * phase — not the query result — decides whether an unanswered environment is
 * still reporting or terminally unreachable.
 */
const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
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
        isPending: result.waiting,
        error: state.kind === "failed" ? "This environment could not report usage." : null,
        summary,
        state,
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  /** True until at least one selected environment has answered. */
  readonly isPending: boolean;
  /**
   * True while selected environments that can still answer are answering.
   * Failed and not-connected environments are reported through their own
   * coverage rows: totals will not improve by waiting on them, so they must not
   * read as "still reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  attribution: UsageAttribution = "pool",
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
        : environments.filter((environment) =>
            selectedEnvironmentIds.has(environment.environmentId),
          ),
    [environments, selectedEnvironmentIds],
  );

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each selected
  // environment's query so the button always rescans exactly the visible scope.
  //
  // Each environment refetches model pricing first, so a model released since
  // its last daily fetch gets priced by the rescan. The rescan runs whether or
  // not the refetch succeeds: an offline environment still recounts tokens.
  const refresh = useCallback(() => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    for (const environment of selectedEnvironments) {
      const { environmentId } = environment;
      const query = serverEnvironment.usageSummary({ environmentId, input });
      void runAtomCommand(
        appAtomRegistry,
        serverEnvironment.refreshUsageRates,
        { environmentId, input: {} },
        { reportFailure: false },
      ).finally(() => appAtomRegistry.refresh(query));
    }
  }, [selectedEnvironments, windowKey]);

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = selectedEnvironments.flatMap((environment) => {
      const state = environmentUsageState(environment);
      return state.kind === "reported"
        ? [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary: state.summary,
            },
          ]
        : [];
    });
    return mergeUsage(answered, USAGE_CONTRACT_VERSION, { attribution });
  }, [selectedEnvironments, attribution]);

  const progress = usageProgress(selectedEnvironments.map(environmentUsageState));

  return {
    merged,
    environments,
    selectedEnvironments,
    isPending: progress.isPending,
    isPartial: progress.isPartial,
    refresh,
  };
}
