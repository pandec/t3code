/**
 * Web access to the cross-environment project accent colors.
 *
 * Accents are server settings (`ServerSettings.projectAccentColors`), one map
 * per environment, so the sidebar merges every connected environment on read
 * and fans a pick out to each environment owning a member of the group. See
 * `@t3tools/client-runtime/state/project-accent-colors` for the rules.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SidebarProjectAccentColor } from "@t3tools/contracts/settings";
import {
  buildProjectAccentColorPatches,
  planProjectAccentColorMigration,
  resolveProjectAccentColor,
  toProjectAccentMembers,
  type ProjectAccentColorMap,
  type ProjectAccentSource,
} from "@t3tools/client-runtime/state/project-accent-colors";

import { derivePhysicalProjectKey } from "~/logicalProject";
import { environmentServerConfigsAtom } from "~/state/server";
import { usePrimaryEnvironmentId } from "~/state/environments";
import {
  useClientSettings,
  useUpdateClientSettings,
  useUpdateSettingsForEnvironment,
} from "./useSettings";

export interface ProjectAccentColors {
  /** Accent for a project group, merged across connected environments. */
  readonly resolve: (
    members: ReadonlyArray<ProjectAccentSource>,
    preferredEnvironmentId?: EnvironmentId | null,
  ) => SidebarProjectAccentColor | null;
  /** Sets (or clears, with null) the accent on every connected member env. */
  readonly update: (
    members: ReadonlyArray<ProjectAccentSource>,
    color: SidebarProjectAccentColor | null,
  ) => void;
}

function useAccentColorsByEnvironment(): ReadonlyMap<EnvironmentId, ProjectAccentColorMap> {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  return useMemo(
    () =>
      new Map(
        [...serverConfigs].map(
          ([environmentId, config]) =>
            [environmentId, config.settings.projectAccentColors] as const,
        ),
      ),
    [serverConfigs],
  );
}

export function useProjectAccentColors(): ProjectAccentColors {
  const accentColorsByEnvironment = useAccentColorsByEnvironment();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const updateEnvironmentSettings = useUpdateSettingsForEnvironment();

  const resolve = useCallback(
    (members: ReadonlyArray<ProjectAccentSource>, preferredEnvironmentId?: EnvironmentId | null) =>
      resolveProjectAccentColor({
        members: toProjectAccentMembers(members),
        accentColorsByEnvironment,
        primaryEnvironmentId,
        preferredEnvironmentId: preferredEnvironmentId ?? null,
      }),
    [accentColorsByEnvironment, primaryEnvironmentId],
  );

  const update = useCallback(
    (members: ReadonlyArray<ProjectAccentSource>, color: SidebarProjectAccentColor | null) => {
      for (const patch of buildProjectAccentColorPatches({
        members: toProjectAccentMembers(members),
        accentColorsByEnvironment,
        color,
      })) {
        updateEnvironmentSettings(patch.environmentId, {
          projectAccentColors: patch.projectAccentColors,
        });
      }
    },
    [accentColorsByEnvironment, updateEnvironmentSettings],
  );

  return useMemo(() => ({ resolve, update }), [resolve, update]);
}

/**
 * Lazily migrates pre-server accent colors out of client settings.
 *
 * Runs whenever projects or connected environment settings change: an entry
 * can only move once its environment is connected AND its project is known,
 * and both arrive asynchronously. The plan is idempotent — migrated entries
 * leave the client map, and an entry whose server-side key already has a
 * color is dropped rather than overwriting it — so re-running is a no-op.
 */
export function useProjectAccentColorMigration(projects: ReadonlyArray<ProjectAccentSource>): void {
  const accentColorsByEnvironment = useAccentColorsByEnvironment();
  const legacyAccentColors = useClientSettings((settings) => settings.sidebarProjectAccentColors);
  const updateEnvironmentSettings = useUpdateSettingsForEnvironment();
  const updateClientSettings = useUpdateClientSettings();
  // One in-flight migration at a time: the server patches are async, so a
  // re-render before they land would otherwise re-send the same writes.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (inFlightRef.current) return;
    if (Object.keys(legacyAccentColors).length === 0) return;

    const plan = planProjectAccentColorMigration({
      clientAccentColors: legacyAccentColors,
      projects,
      accentColorsByEnvironment,
      deriveLegacyKey: derivePhysicalProjectKey,
    });
    if (plan.nextClientAccentColors === null) return;

    inFlightRef.current = true;
    for (const patch of plan.patches) {
      updateEnvironmentSettings(patch.environmentId, {
        projectAccentColors: patch.projectAccentColors,
      });
    }
    updateClientSettings({ sidebarProjectAccentColors: plan.nextClientAccentColors });
    inFlightRef.current = false;
  }, [
    accentColorsByEnvironment,
    legacyAccentColors,
    projects,
    updateClientSettings,
    updateEnvironmentSettings,
  ]);
}
