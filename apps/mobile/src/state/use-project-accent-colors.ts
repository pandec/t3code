import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  resolveProjectAccentColor,
  toProjectAccentMembers,
  type ProjectAccentSource,
} from "@t3tools/client-runtime/state/project-accent-colors";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SidebarProjectAccentColor } from "@t3tools/contracts/settings";
import { useCallback, useEffect, useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import {
  ensureProjectAccentColorCacheLoaded,
  mergeProjectAccentColorCache,
  projectAccentColorCacheAtom,
  recordProjectAccentColors,
  type ProjectAccentColorsByEnvironment,
} from "./project-accent-color-cache";
import { environmentPresentations } from "./presentation";

/** Accent maps reported by the environments that are connected right now. */
function liveProjectAccentColors(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
): ProjectAccentColorsByEnvironment {
  return new Map(
    [...presentations].flatMap(([environmentId, presentation]) =>
      presentation.connection.phase === "connected" && presentation.serverConfig !== null
        ? [[environmentId, presentation.serverConfig.settings.projectAccentColors] as const]
        : [],
    ),
  );
}

/**
 * Project accent colors as seen by mobile: read-only.
 *
 * They live in each server's settings, so the phone gets them for free from
 * the per-environment `ServerConfig` it already holds, backed by the on-device
 * cache so a launch does not render colorless rows first. Picking a color stays
 * a desktop/web affordance; mobile only renders what the servers report, merged
 * across every environment.
 *
 * No primary environment is passed: mobile has no "local" server, so the
 * fallback order is purely the shared deterministic one (environmentId).
 *
 * The accent-tint opt-out deliberately does NOT land here: it gates the wash
 * at the paint site (`resolveRowAccentTintAlpha`) so a project keeps its
 * group-header dot with tints off, which is what web does too.
 */
export function useProjectAccentColors(): (
  members: ReadonlyArray<ProjectAccentSource>,
) => SidebarProjectAccentColor | null {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const cachedAccentColors = useAtomValue(projectAccentColorCacheAtom);
  const liveAccentColors = useMemo(() => liveProjectAccentColors(presentations), [presentations]);
  const accentColorsByEnvironment = useMemo(
    () =>
      mergeProjectAccentColorCache({
        cached: cachedAccentColors,
        live: liveAccentColors,
        knownEnvironmentIds: null,
      }),
    [cachedAccentColors, liveAccentColors],
  );

  return useCallback(
    (members) =>
      resolveProjectAccentColor({
        members: toProjectAccentMembers(members),
        accentColorsByEnvironment,
      }),
    [accentColorsByEnvironment],
  );
}

/**
 * Keeps the on-device accent cache in step with the servers. Mounted once from
 * the root layout: the cache is app-wide state, and hydrating it there gets the
 * read done before the thread list first paints.
 */
export function useProjectAccentColorCacheSync(): void {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);

  useEffect(() => {
    ensureProjectAccentColorCacheLoaded();
  }, []);

  useEffect(() => {
    recordProjectAccentColors({
      live: liveProjectAccentColors(presentations),
      // An unready catalog is not yet the environment list; pruning against it
      // would drop every cached map on launch.
      knownEnvironmentIds: catalog.isReady ? new Set(catalog.entries.keys()) : null,
    });
  }, [catalog, presentations]);
}
