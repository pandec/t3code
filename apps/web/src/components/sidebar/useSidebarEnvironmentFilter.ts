import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentPresentation } from "../../state/environments";
import { olderSettledThreads } from "../../state/threads";
import { useUiStateStore } from "../../uiStateStore";
import {
  countSidebarEnvironmentThreads,
  resolveSidebarEnvironmentScope,
  selectPrimaryEnvironmentScope,
  selectRemoteEnvironmentScope,
  sidebarEnvironmentScopeSignature,
  toggleSidebarEnvironmentScope,
  type SidebarEnvironmentScope,
} from "./environmentScope";
import { buildProviderEnvironmentOptions } from "../settings/ProviderSettingsPanel.logic";
import {
  resolveSidebarEnvironmentEmptyStateLabel,
  type SidebarEnvironmentFilterEnvironment,
} from "./SidebarEnvironmentFilter";

export function useSidebarEnvironmentFilter(input: {
  readonly environments: readonly EnvironmentPresentation[];
  readonly environmentsReady: boolean;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly hiddenProjectKeys: ReadonlySet<string>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly shellsBootstrapped: boolean;
}) {
  const storedScopeIds = useUiStateStore((store) => store.sidebarV2EnvironmentScopeIds);
  const setStoredScopeIds = useUiStateStore((store) => store.setSidebarV2EnvironmentScopeIds);
  const scope: SidebarEnvironmentScope = storedScopeIds === null ? null : new Set(storedScopeIds);
  // Before hydration an empty environment list looks like "every selection was removed":
  // resolving would hide everything or, since null means all, widen the filter for a
  // frame. Use raw intent until the catalog can answer.
  const resolvedScope = input.environmentsReady
    ? resolveSidebarEnvironmentScope(input.environments, scope)
    : scope;
  const sortedEnvironments = buildProviderEnvironmentOptions(
    input.environments,
    input.primaryEnvironmentId,
  );
  // Zero pages: only each environment's cut and counts, which read no rows.
  const olderSettled = useAtomValue(
    olderSettledThreads.shelfAtom(
      input.environments.map((environment) => ({
        scope: { environmentId: environment.environmentId, projectIds: null },
        pages: 0,
      })),
    ),
  );
  const threadCountByEnvironmentId = countSidebarEnvironmentThreads({
    threads: input.threads,
    olderSettled,
    isProjectVisible:
      input.hiddenProjectKeys.size === 0 && input.scopedProjectKeys === null
        ? null
        : (projectKey) =>
            !input.hiddenProjectKeys.has(projectKey) &&
            (input.scopedProjectKeys === null || input.scopedProjectKeys.has(projectKey)),
  });
  const environments: readonly SidebarEnvironmentFilterEnvironment[] = sortedEnvironments.map(
    (environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      connection: environment.connection,
      isPrimary: environment.environmentId === input.primaryEnvironmentId,
      threadCount: threadCountByEnvironmentId.get(environment.environmentId) ?? 0,
    }),
  );
  const emptyStateLabel = input.environmentsReady
    ? resolveSidebarEnvironmentEmptyStateLabel({
        environments,
        scope,
        shellsBootstrapped: input.shellsBootstrapped,
      })
    : null;
  // Archived recents follow the scope like live rows do, so only the scoped
  // environments' per-environment RPCs are subscribed; an unresolved catalog
  // subscribes nothing rather than paging remote links for rows that may
  // not render.
  const environmentIds = !input.environmentsReady
    ? []
    : resolvedScope === null
      ? input.environments.map((environment) => environment.environmentId)
      : input.environments.flatMap((environment) =>
          resolvedScope.has(environment.environmentId) ? [environment.environmentId] : [],
        );
  const toggleEnvironment = (environmentId: string) => {
    const currentIds = useUiStateStore.getState().sidebarV2EnvironmentScopeIds;
    const currentScope = currentIds === null ? null : new Set(currentIds);
    const resolvedCurrentScope = resolveSidebarEnvironmentScope(input.environments, currentScope);
    const next = toggleSidebarEnvironmentScope(resolvedCurrentScope, environmentId);
    setStoredScopeIds(next === null ? null : [...next]);
  };
  const selectAll = () => setStoredScopeIds(null);
  const selectPrimaryOnly = () => {
    const primaryEnvironmentId = environments.find(
      (environment) => environment.isPrimary,
    )?.environmentId;
    const next = selectPrimaryEnvironmentScope(primaryEnvironmentId ?? null);
    if (next !== null) setStoredScopeIds([...next]);
  };
  const selectRemoteOnly = () => {
    const primaryEnvironmentId = environments.find(
      (environment) => environment.isPrimary,
    )?.environmentId;
    const next = selectRemoteEnvironmentScope(environments, primaryEnvironmentId ?? null);
    if (next !== null) setStoredScopeIds([...next]);
  };
  const signature = sidebarEnvironmentScopeSignature(scope);

  return {
    emptyStateLabel,
    environmentIds,
    environments,
    // Raw intent, hydrated or not: handing the menu null before the catalog
    // arrives would drop the trigger below its two-environment threshold and
    // hide an active filter at the one moment the user cannot tell why.
    menuScope: scope,
    resolvedScope,
    scope,
    selectAll,
    selectPrimaryOnly,
    selectRemoteOnly,
    signature,
    toggleEnvironment,
  };
}
