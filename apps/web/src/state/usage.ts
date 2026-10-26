import { useAtomValue } from "@effect/atom-react";
import { needsCursorKeychainAccess, refreshUsage } from "@t3tools/client-runtime/state/usage";
import {
  AuthDiagnosticsReadScope,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageSummary,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { resolveUsageAccess } from "@t3tools/client-runtime/state/usage-access";
import {
  attributeGatewayBucket,
  mergeUsage,
  type EnvironmentUsage,
  type MergedUsage,
  type UsageAttribution,
} from "@t3tools/shared/usageMerge";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  classifyEnvironmentUsage,
  usageProgress,
  type EnvironmentUsageState,
} from "../usage/usageCoverage";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentSession, readEnvironmentScope } from "./session";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly canReadDiagnostics: boolean;
  readonly isConnected: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
  /** Rich coverage classification layered over upstream's progressive status fields. */
  readonly state?: EnvironmentUsageState;
  readonly needsCursorKeychainAccess: boolean;
}

function environmentUsageState(environment: EnvironmentUsageStatus): EnvironmentUsageState {
  if (environment.state !== undefined) return environment.state;
  if (environment.summary !== null) return { kind: "reported", summary: environment.summary };
  return environment.error === null ? { kind: "reporting" } : { kind: "failed" };
}

/**
 * Keyed by the serialised window so switching ranges does not thrash the atom cache and
 * readers of one window share each query. A never-connected environment's query stays
 * pending forever, so the connection phase, not the query result, decides whether it is
 * still reporting or terminally unreachable.
 */
const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const isConnected = presentation.connection.phase === "connected";
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const session = Option.getOrNull(AsyncResult.value(sessionResult));
      const hasSessionError = sessionResult._tag === "Failure";
      const access = resolveUsageAccess({
        connectionPhase: presentation.connection.phase,
        session,
        hasSessionError,
      });
      if (!access.canReadDiagnostics) {
        statuses.push({
          environmentId,
          label: presentation.entry.target.label,
          isConnected,
          ...access,
          summary: null,
          // A known denial is terminal; an unchecked session waits like any
          // other unanswered environment, or reads as not connected.
          state: classifyEnvironmentUsage({
            phase: presentation.connection.phase,
            failed: session !== null || hasSessionError,
            summary: null,
          }),
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
        isPending: result.waiting,
        canReadDiagnostics: true,
        isConnected,
        error: state.kind === "failed" ? "This environment could not report usage." : null,
        summary,
        state,
        needsCursorKeychainAccess: needsCursorKeychainAccess(
          state.kind === "reported" ? state.summary : null,
          get(serverEnvironment.providersValueAtom(environmentId)),
        ),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly isPending: boolean;
  /**
   * The usage to draw: this window's once a selected environment answers,
   * until then the last window answered for the same selection and grouping.
   * Null while nothing has answered and something still could.
   */
  readonly shown: { readonly window: UsageSummaryInput; readonly merged: MergedUsage } | null;
  /**
   * The selected environments with hidden providers' buckets and sources
   * removed, for any further merge (a model's detail) that must match `merged`.
   */
  readonly visibleEnvironments: readonly EnvironmentUsageStatus[];
  /**
   * True while selected environments that can still answer are answering.
   * Failed and not-connected environments are reported through their own
   * coverage rows: totals will not improve by waiting on them, so they must not
   * read as "still reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: (input?: UsageSummaryInput) => Promise<void>;
}

/**
 * `keepBucket` narrows the merge (e.g. to one model) with source ownership still applied,
 * so the result matches that slice of the full merge; session counts are not narrowed.
 * `attribution` must match the full merge's so a slice credits gateway buckets alike.
 */
function mergeAnsweredUsage(
  environments: readonly EnvironmentUsageStatus[],
  keepBucket?: (bucket: UsageBucket) => boolean,
  attribution: UsageAttribution = "pool",
): MergedUsage {
  const answered: EnvironmentUsage[] = environments.flatMap((environment) => {
    const state = environmentUsageState(environment);
    if (state.kind !== "reported") return [];
    const { summary } = state;
    return [
      {
        environmentId: environment.environmentId,
        label: environment.label,
        summary:
          keepBucket === undefined
            ? summary
            : { ...summary, buckets: summary.buckets.filter(keepBucket) },
      },
    ];
  });
  return mergeUsage(answered, USAGE_CONTRACT_VERSION, { attribution });
}

/**
 * Pool attribution can credit a model's buckets to a provider other than the scanning
 * harness, so narrow by model name first: if every merged row for it lands on the row's
 * provider, that is the row. Otherwise the scanned provider decides.
 */
export function mergeModelUsage(
  environments: readonly EnvironmentUsageStatus[],
  model: { readonly provider: UsageBucket["provider"]; readonly model: string },
  attribution: UsageAttribution = "pool",
): MergedUsage {
  const byName = mergeAnsweredUsage(
    environments,
    (bucket) => bucket.model === model.model,
    attribution,
  );
  if (byName.models.every((row) => row.provider === model.provider)) return byName;
  return mergeAnsweredUsage(
    environments,
    (bucket) => bucket.provider === model.provider && bucket.model === model.model,
    attribution,
  );
}

const NO_HIDDEN_PROVIDERS: ReadonlySet<UsageProviderKind> = new Set();

/**
 * Filters the summary the merge reads so totals, shares, and session counts cover only visible
 * providers. Under `"pool"` a bucket drops only when its credited pool is hidden and every source
 * stays (hidden apps' sessions zeroed), since sources decide ownership; removing a bucket never
 * changes another's, so this matches filtering after ownership and attribution.
 */
function withoutProviders(
  environments: readonly EnvironmentUsageStatus[],
  hiddenProviders: ReadonlySet<UsageProviderKind>,
  attribution: UsageAttribution,
): readonly EnvironmentUsageStatus[] {
  if (hiddenProviders.size === 0) return environments;
  const visible = (summary: UsageSummary): UsageSummary => ({
    ...summary,
    buckets: summary.buckets.filter(
      (bucket) =>
        !hiddenProviders.has(
          attribution === "pool" ? attributeGatewayBucket(bucket).provider : bucket.provider,
        ),
    ),
    sources:
      attribution === "pool"
        ? summary.sources.map((source) =>
            hiddenProviders.has(source.fingerprint.provider)
              ? { ...source, distinctSessions: 0 }
              : source,
          )
        : summary.sources.filter((source) => !hiddenProviders.has(source.fingerprint.provider)),
  });
  return environments.map((environment) => {
    const state = environmentUsageState(environment);
    const summary = environment.summary === null ? null : visible(environment.summary);
    return {
      ...environment,
      summary,
      state:
        state.kind !== "reported"
          ? state
          : {
              kind: "reported",
              summary:
                summary !== null && state.summary === environment.summary
                  ? summary
                  : visible(state.summary),
            },
    };
  });
}

export interface UsageOptions {
  /** Gateway grouping; must match any further merge of the same view. */
  readonly attribution?: UsageAttribution;
  readonly hiddenProviders?: ReadonlySet<UsageProviderKind>;
}

function deriveSelection(
  environments: readonly EnvironmentUsageStatus[],
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
  attribution: UsageAttribution,
) {
  const selectedEnvironments =
    selectedEnvironmentIds === null
      ? environments
      : environments.filter((environment) => selectedEnvironmentIds.has(environment.environmentId));
  const visibleEnvironments = withoutProviders(selectedEnvironments, hiddenProviders, attribution);
  return {
    environments,
    selectedEnvironmentIds,
    hiddenProviders,
    attribution,
    selectedEnvironments,
    visibleEnvironments,
    merged: mergeAnsweredUsage(visibleEnvironments, undefined, attribution),
  };
}

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  { attribution = "pool", hiddenProviders = NO_HIDDEN_PROVIDERS }: UsageOptions = {},
): UsageView {
  const windowKey = JSON.stringify({
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    resolution: input.resolution,
    sinceTime: input.sinceTime,
    untilTime: input.untilTime,
  });
  const atom = usageByWindowAtom(windowKey);
  const environments = useAtomValue(atom);
  // Identity-based render sync needs a derivation retained by inputs across renders.
  const [derived, setDerived] = useState(() =>
    deriveSelection(environments, selectedEnvironmentIds, hiddenProviders, attribution),
  );
  let current = derived;
  if (
    derived.environments !== environments ||
    derived.selectedEnvironmentIds !== selectedEnvironmentIds ||
    derived.hiddenProviders !== hiddenProviders ||
    derived.attribution !== attribution
  ) {
    current = deriveSelection(environments, selectedEnvironmentIds, hiddenProviders, attribution);
    setDerived(current);
  }
  const { selectedEnvironments, visibleEnvironments, merged } = current;

  const refresh = (nextInput?: UsageSummaryInput) =>
    refreshUsage({
      registry: appAtomRegistry,
      server: serverEnvironment,
      presentations: environmentPresentations,
      environmentIds: selectedEnvironments
        .filter(
          (environment) =>
            environment.canReadDiagnostics &&
            readEnvironmentScope(environment.environmentId, AuthDiagnosticsReadScope),
        )
        .map(({ environmentId }) => environmentId),
      input: nextInput ?? (JSON.parse(windowKey) as UsageSummaryInput),
    });

  const progress = usageProgress(selectedEnvironments.map(environmentUsageState));
  const answered = selectedEnvironments.some(
    (environment) => environmentUsageState(environment).kind === "reported",
  );

  const [lastAnswered, setLastAnswered] = useState<
    | (NonNullable<UsageView["shown"]> & {
        readonly selection: typeof selectedEnvironmentIds;
        readonly hidden: typeof hiddenProviders;
        readonly attribution: UsageAttribution;
      })
    | null
  >(null);
  if (
    answered &&
    (lastAnswered?.merged !== merged ||
      lastAnswered.window !== input ||
      lastAnswered.selection !== selectedEnvironmentIds ||
      lastAnswered.hidden !== hiddenProviders ||
      lastAnswered.attribution !== attribution)
  ) {
    setLastAnswered({
      window: input,
      merged,
      selection: selectedEnvironmentIds,
      hidden: hiddenProviders,
      attribution,
    });
  }
  // Kept usage only stands in for the same environments, provider filter and
  // grouping.
  const kept =
    lastAnswered?.selection === selectedEnvironmentIds &&
    lastAnswered.hidden === hiddenProviders &&
    lastAnswered.attribution === attribution
      ? lastAnswered
      : null;
  const shown = answered
    ? { window: input, merged }
    : (kept ?? (progress.isPending ? null : { window: input, merged }));

  return {
    merged,
    environments,
    selectedEnvironments,
    visibleEnvironments,
    isPending: progress.isPending,
    shown,
    isPartial: progress.isPartial,
    refresh,
  };
}
