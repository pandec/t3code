import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import type { HomeListFilterMenuModel } from "./home-list-filter-menu";

/**
 * The models the live threads actually run on, for the filter menu.
 * Derived from the threads rather than the provider catalogs so the menu only
 * offers filters that can match something, and threads on models the
 * environment no longer advertises stay reachable.
 *
 * Identity is the model slug: the same model reached through two provider
 * instances (or two machines) is one filter entry, which is what "filter by
 * model" means to the user. Labels come from the environment catalog when it
 * knows the slug, so the menu reads "Opus 4.5" rather than the raw id.
 *
 * Deliberately not scoped to the environment filter: the two filters compose,
 * and scoping would make the set of valid model pins depend on a value this
 * same hook chain has yet to resolve.
 */
export function buildHomeModelFilterOptions(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
}): ReadonlyArray<HomeListFilterMenuModel> {
  const labelBySlug = new Map<string, string>();
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const slug: string = thread.modelSelection.model;
    // A slug placeholder is not a resolved label: an environment that is still
    // connecting reports no catalog, and whichever thread happened to come
    // first would otherwise pin the raw id even though a peer environment
    // knows the friendly name.
    const known = labelBySlug.get(slug);
    if (known !== undefined && known !== slug) continue;
    const label = input.serverConfigs
      .get(thread.environmentId)
      ?.providers.flatMap((provider) => provider.models)
      .find((model) => model.slug === slug)?.name;
    labelBySlug.set(slug, label ?? slug);
  }

  return [...labelBySlug]
    .map(([key, label]) => ({ key, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}
