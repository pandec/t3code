import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { useUiStateStore } from "../../uiStateStore";
import {
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
  const scope = useMemo<SidebarEnvironmentScope>(
    () => (storedScopeIds === null ? null : new Set(storedScopeIds)),
    [storedScopeIds],
  );
  // Before the catalog hydrates, an empty environment list is indistinguishable
  // from "every selection was removed". Resolving against it would either hide
  // everything or — since null means all — widen the filter for a frame, which
  // is exactly what the scope is designed never to do. Client-persisted drafts
  // exist before any environment does and would be the visible tell, so fall
  // back to raw intent until the catalog can be trusted to answer.
  const resolvedScope = useMemo(
    () =>
      input.environmentsReady ? resolveSidebarEnvironmentScope(input.environments, scope) : scope,
    [input.environments, input.environmentsReady, scope],
  );
  const sortedEnvironments = useMemo(
    () => buildProviderEnvironmentOptions(input.environments, input.primaryEnvironmentId),
    [input.environments, input.primaryEnvironmentId],
  );
  const threadCountByEnvironmentId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of input.threads) {
      const projectKey = `${thread.environmentId}:${thread.projectId}`;
      if (
        thread.archivedAt !== null ||
        input.hiddenProjectKeys.has(projectKey) ||
        (input.scopedProjectKeys !== null && !input.scopedProjectKeys.has(projectKey))
      ) {
        continue;
      }
      counts.set(thread.environmentId, (counts.get(thread.environmentId) ?? 0) + 1);
    }
    return counts;
  }, [input.hiddenProjectKeys, input.scopedProjectKeys, input.threads]);
  const environments = useMemo<readonly SidebarEnvironmentFilterEnvironment[]>(
    () =>
      sortedEnvironments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        connection: environment.connection,
        isPrimary: environment.environmentId === input.primaryEnvironmentId,
        threadCount: threadCountByEnvironmentId.get(environment.environmentId) ?? 0,
      })),
    [input.primaryEnvironmentId, sortedEnvironments, threadCountByEnvironmentId],
  );
  const emptyStateLabel = useMemo(
    () =>
      input.environmentsReady
        ? resolveSidebarEnvironmentEmptyStateLabel({
            environments,
            scope,
            shellsBootstrapped: input.shellsBootstrapped,
          })
        : null,
    [environments, input.environmentsReady, input.shellsBootstrapped, scope],
  );
  // Archived recents are hidden outright while any scope is set (matching the
  // project filter), so subscribing to their per-environment RPCs would page
  // remote links for rows that are guaranteed not to render.
  const environmentIds = useMemo(
    () =>
      input.environmentsReady && scope === null
        ? input.environments.map((environment) => environment.environmentId)
        : [],
    [input.environments, input.environmentsReady, scope],
  );
  const toggleEnvironment = useCallback(
    (environmentId: string) => {
      const currentIds = useUiStateStore.getState().sidebarV2EnvironmentScopeIds;
      const currentScope = currentIds === null ? null : new Set(currentIds);
      const resolvedCurrentScope = resolveSidebarEnvironmentScope(input.environments, currentScope);
      const next = toggleSidebarEnvironmentScope(resolvedCurrentScope, environmentId);
      setStoredScopeIds(next === null ? null : [...next]);
    },
    [input.environments, setStoredScopeIds],
  );
  const selectAll = useCallback(() => setStoredScopeIds(null), [setStoredScopeIds]);
  const selectPrimaryOnly = useCallback(() => {
    const primaryEnvironmentId = environments.find(
      (environment) => environment.isPrimary,
    )?.environmentId;
    const next = selectPrimaryEnvironmentScope(primaryEnvironmentId ?? null);
    if (next !== null) setStoredScopeIds([...next]);
  }, [environments, setStoredScopeIds]);
  const selectRemoteOnly = useCallback(() => {
    const primaryEnvironmentId = environments.find(
      (environment) => environment.isPrimary,
    )?.environmentId;
    const next = selectRemoteEnvironmentScope(environments, primaryEnvironmentId ?? null);
    if (next !== null) setStoredScopeIds([...next]);
  }, [environments, setStoredScopeIds]);
  const signature = useMemo(() => sidebarEnvironmentScopeSignature(scope), [scope]);

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
