import { useAtomValue } from "@effect/atom-react";
import {
  resolveProjectAccentColor,
  toProjectAccentMembers,
  type ProjectAccentColorMap,
  type ProjectAccentSource,
} from "@t3tools/client-runtime/state/project-accent-colors";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SidebarProjectAccentColor } from "@t3tools/contracts/settings";
import { useCallback, useMemo } from "react";

import { environmentServerConfigsAtom } from "./server";

/**
 * Project accent colors as seen by mobile: read-only.
 *
 * They live in each server's settings, so the phone gets them for free from
 * the per-environment `ServerConfig` it already holds. Picking a color stays a
 * desktop/web affordance; mobile only renders what the servers report, merged
 * across every connected environment.
 *
 * No primary environment is passed: mobile has no "local" server, so the
 * fallback order is purely the shared deterministic one (environmentId).
 */
export function useProjectAccentColors(): (
  members: ReadonlyArray<ProjectAccentSource>,
) => SidebarProjectAccentColor | null {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const accentColorsByEnvironment = useMemo<ReadonlyMap<EnvironmentId, ProjectAccentColorMap>>(
    () =>
      new Map(
        [...serverConfigs].map(
          ([environmentId, config]) =>
            [environmentId, config.settings.projectAccentColors] as const,
        ),
      ),
    [serverConfigs],
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
