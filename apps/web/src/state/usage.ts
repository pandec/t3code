/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import {
  classifyEnvironmentUsage,
  usageProgress,
  type EnvironmentUsageState,
} from "../usage/usageCoverage";
import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "../usage/usageMerge";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly state: EnvironmentUsageState;
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
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        state: classifyEnvironmentUsage({
          phase: presentation.connection.phase,
          failed: result._tag === "Failure",
          summary: Option.getOrNull(AsyncResult.value(result)),
        }),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that can still answer are answering. Failed and
   * not-connected environments are reported through their own coverage rows:
   * totals will not improve by waiting on them, so they must not read as
   * "still reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useUsage(input: UsageSummaryInput): UsageView {
  const windowKey = useMemo(
    () =>
      JSON.stringify({
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        timeZone: input.timeZone,
      }),
    [input.sinceDay, input.untilDay, input.timeZone],
  );
  const atom = usageByWindowAtom(windowKey);
  const environments = useAtomValue(atom);

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so the button always rescans.
  const refresh = useCallback(() => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.usageSummary({ environmentId: environment.environmentId, input }),
      );
    }
  }, [environments, windowKey]);

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = environments.flatMap((environment) =>
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
  }, [environments]);

  const progress = usageProgress(environments.map((environment) => environment.state));

  return {
    merged,
    environments,
    isPending: progress.isPending,
    isPartial: progress.isPartial,
    refresh,
  };
}
