import { toggleSidebarProjectScope } from "../Sidebar.logic";

/**
 * Kept apart from `Sidebar.logic.ts` to limit upstream merge cost: that file is
 * upstream-owned, and these helpers are used only by `useSidebarEnvironmentFilter`.
 */
export type SidebarEnvironmentScope = ReadonlySet<string> | null;

/**
 * Deliberately the project algorithm, not a copy of it: null solo-selects, a
 * repeat toggle removes, and emptying the set collapses back to null (= all).
 * The two filters must never drift apart on that behaviour.
 */
export function toggleSidebarEnvironmentScope(
  scope: SidebarEnvironmentScope,
  environmentId: string,
): SidebarEnvironmentScope {
  return toggleSidebarProjectScope(scope, environmentId);
}

/** Sorted, so an equal set never reads as a change to effect dependencies. */
export function sidebarEnvironmentScopeSignature(scope: SidebarEnvironmentScope): string {
  return scope === null ? "all" : `environments:${JSON.stringify([...scope].toSorted())}`;
}

/**
 * The scope stores intent and resolves against current environments instead of being
 * pruned: one leaving the catalog would otherwise permanently narrow the selection. A
 * scope whose environments all disappeared resolves to an EMPTY set, never to null
 * (which would broaden it to everything).
 */
export function resolveSidebarEnvironmentScope(
  environments: readonly { readonly environmentId: string }[],
  scope: SidebarEnvironmentScope,
): SidebarEnvironmentScope {
  if (scope === null) return null;

  return new Set(
    environments.flatMap((environment) =>
      scope.has(environment.environmentId) ? [environment.environmentId] : [],
    ),
  );
}

export function selectPrimaryEnvironmentScope(
  primaryEnvironmentId: string | null,
): SidebarEnvironmentScope {
  return primaryEnvironmentId === null ? null : new Set([primaryEnvironmentId]);
}

// Without a known primary every environment qualifies, persisting an all-environments
// scope labeled "remote only". The primary registers asynchronously after persisted
// environments hydrate, and the persisted id set never corrects itself once it lands.
export function selectRemoteEnvironmentScope(
  environments: readonly { readonly environmentId: string }[],
  primaryEnvironmentId: string | null,
): SidebarEnvironmentScope {
  if (primaryEnvironmentId === null) {
    return null;
  }
  const remoteEnvironmentIds = environments.flatMap((environment) =>
    environment.environmentId === primaryEnvironmentId ? [] : [environment.environmentId],
  );
  return remoteEnvironmentIds.length === 0 ? null : new Set(remoteEnvironmentIds);
}
