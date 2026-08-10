import { toggleSidebarProjectScope } from "../Sidebar.logic";

/**
 * Scope helpers for the sidebar environment filter.
 *
 * These live here rather than beside their project-scope counterparts in
 * `Sidebar.logic.ts` purely for merge cost: that file is upstream-owned and
 * actively edited upstream, while every symbol below is consumed only by
 * `useSidebarEnvironmentFilter`. Keeping fork-only logic out of a contended
 * file is worth the split.
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
 * The scope stores intent and is resolved against the environments that exist
 * right now instead of being pruned into state: an environment that drops out
 * of the catalog would otherwise silently and permanently narrow the selection,
 * with no way to tell that from a deliberate one. A scope whose environments
 * have all disappeared resolves to an EMPTY set — matching nothing — never to
 * null, which would broaden it to everything.
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

// Without a known primary, "remote" is not yet a meaningful distinction: every
// environment would qualify and the result would be an every-environment scope
// wearing a "remote only" label. Persisted environments hydrate synchronously
// while the primary registration arrives over an async round-trip, so this is a
// real window on cold start — and the scope it would persist is a static id set
// that never corrects itself once the primary lands.
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
