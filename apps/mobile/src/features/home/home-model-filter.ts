import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import type { HomeListFilterMenuModel } from "./home-list-filter-menu";

/**
 * The models the visible threads actually run on, for the filter menu.
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
    if (labelBySlug.has(slug)) continue;
    const label = input.serverConfigs
      .get(thread.environmentId)
      ?.providers.flatMap((provider) => provider.models)
      .find((model) => model.slug === slug)?.name;
    labelBySlug.set(slug, label ?? slug);
  }

  return Arr.sort(
    [...labelBySlug].map(([key, label]) => ({ key, label })),
    Order.mapInput(Order.String, (option: HomeListFilterMenuModel) => option.label),
  );
}
