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
  collectWritableProjectAccentKeys,
  planProjectAccentColorMigration,
  resolveProjectAccentColor,
  toProjectAccentMembers,
  withProjectAccentKeys,
  type ProjectAccentColorMap,
  type ProjectAccentSource,
} from "@t3tools/client-runtime/state/project-accent-colors";

import { derivePhysicalProjectKey } from "~/logicalProject";
import { environmentPresentations } from "~/state/presentation";
import { enqueueProjectAccentColorWrite } from "./projectAccentColorWriteQueue";
import {
  getClientSettings,
  useClientSettings,
  useUpdateClientSettings,
  useUpdateSettingsForEnvironment,
} from "./useSettings";

export interface ProjectAccentColors {
  /** Accent for a project group, merged across connected environments. */
  readonly resolve: (
    members: ReadonlyArray<ProjectAccentSource>,
  ) => SidebarProjectAccentColor | null;
  /** Sets (or clears, with null) the accent on every connected member env. */
  readonly update: (
    members: ReadonlyArray<ProjectAccentSource>,
    color: SidebarProjectAccentColor | null,
  ) => void;
  /** Clears every connected server map plus any not-yet-migrated client map. */
  readonly clearAll: () => void;
  readonly hasAnyServerAccentColors: boolean;
}

interface AccentEnvironmentState {
  readonly accentColorsByEnvironment: ReadonlyMap<EnvironmentId, ProjectAccentColorMap>;
  readonly writableEnvironmentIds: ReadonlySet<EnvironmentId>;
}

function useAccentEnvironmentState(): AccentEnvironmentState {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  return useMemo(() => {
    const accentColorsByEnvironment = new Map<EnvironmentId, ProjectAccentColorMap>();
    const writableEnvironmentIds = new Set<EnvironmentId>();
    for (const [environmentId, presentation] of presentations) {
      const config = presentation.serverConfig;
      if (presentation.connection.phase !== "connected" || config === null) continue;
      accentColorsByEnvironment.set(environmentId, config.settings.projectAccentColors);
      if (config.environment.capabilities.projectAccentColors === true) {
        writableEnvironmentIds.add(environmentId);
      }
    }
    return { accentColorsByEnvironment, writableEnvironmentIds };
  }, [presentations]);
}

function usePersistProjectAccentColors() {
  const updateEnvironmentSettings = useUpdateSettingsForEnvironment();
  return useCallback(
    async (
      environmentId: EnvironmentId,
      projectAccentColors: Record<string, SidebarProjectAccentColor>,
    ): Promise<ProjectAccentColorMap | null> => {
      const result = await updateEnvironmentSettings(environmentId, { projectAccentColors });
      return result?._tag === "Success" ? result.value.projectAccentColors : null;
    },
    [updateEnvironmentSettings],
  );
}

export function useProjectAccentColors(): ProjectAccentColors {
  const { accentColorsByEnvironment, writableEnvironmentIds } = useAccentEnvironmentState();
  const persistAccentColors = usePersistProjectAccentColors();
  const updateClientSettings = useUpdateClientSettings();
  const accentColorsRef = useRef(accentColorsByEnvironment);
  accentColorsRef.current = accentColorsByEnvironment;

  const resolve = useCallback(
    (members: ReadonlyArray<ProjectAccentSource>) =>
      resolveProjectAccentColor({
        members: toProjectAccentMembers(members),
        accentColorsByEnvironment,
      }),
    [accentColorsByEnvironment],
  );

  const update = useCallback(
    (members: ReadonlyArray<ProjectAccentSource>, color: SidebarProjectAccentColor | null) => {
      const accentKeysByEnvironment = collectWritableProjectAccentKeys({
        members: toProjectAccentMembers(members),
        accentColorsByEnvironment,
        writableEnvironmentIds,
      });
      for (const [environmentId, accentKeys] of accentKeysByEnvironment) {
        void enqueueProjectAccentColorWrite({
          environmentId,
          fallbackMap: accentColorsByEnvironment.get(environmentId) ?? {},
          readCurrentMap: () => accentColorsRef.current.get(environmentId),
          update: (current) => withProjectAccentKeys(current, accentKeys, color),
          persist: (projectAccentColors) => persistAccentColors(environmentId, projectAccentColors),
        });
      }
    },
    [accentColorsByEnvironment, persistAccentColors, writableEnvironmentIds],
  );

  const clearAll = useCallback(() => {
    for (const environmentId of writableEnvironmentIds) {
      const current = accentColorsByEnvironment.get(environmentId);
      if (current === undefined || Object.keys(current).length === 0) continue;
      void enqueueProjectAccentColorWrite({
        environmentId,
        fallbackMap: current,
        readCurrentMap: () => accentColorsRef.current.get(environmentId),
        update: (latest) => ({
          next: {},
          changed: Object.keys(latest).length > 0,
        }),
        persist: (projectAccentColors) => persistAccentColors(environmentId, projectAccentColors),
      });
    }
    updateClientSettings({ sidebarProjectAccentColors: {} });
  }, [
    accentColorsByEnvironment,
    persistAccentColors,
    updateClientSettings,
    writableEnvironmentIds,
  ]);

  const hasAnyServerAccentColors = useMemo(
    () =>
      [...accentColorsByEnvironment.values()].some(
        (accentColors) => Object.keys(accentColors).length > 0,
      ),
    [accentColorsByEnvironment],
  );

  return useMemo(
    () => ({ resolve, update, clearAll, hasAnyServerAccentColors }),
    [clearAll, hasAnyServerAccentColors, resolve, update],
  );
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
  const { accentColorsByEnvironment, writableEnvironmentIds } = useAccentEnvironmentState();
  const legacyAccentColors = useClientSettings((settings) => settings.sidebarProjectAccentColors);
  const persistAccentColors = usePersistProjectAccentColors();
  const updateClientSettings = useUpdateClientSettings();
  const accentColorsRef = useRef(accentColorsByEnvironment);
  accentColorsRef.current = accentColorsByEnvironment;
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
      writableEnvironmentIds,
      deriveLegacyKey: derivePhysicalProjectKey,
    });
    if (plan.patches.length === 0 && plan.consumedWithoutWrite.length === 0) return;

    inFlightRef.current = true;
    void (async () => {
      const consumedLegacyKeys = new Set(plan.consumedWithoutWrite);
      try {
        await Promise.all(
          plan.patches.map(async (patch) => {
            const persisted = await enqueueProjectAccentColorWrite({
              environmentId: patch.environmentId,
              fallbackMap:
                accentColorsByEnvironment.get(patch.environmentId) ?? patch.projectAccentColors,
              readCurrentMap: () => accentColorsRef.current.get(patch.environmentId),
              update: (current) => {
                const next = { ...current };
                let changed = false;
                for (const migration of patch.migrations) {
                  if (next[migration.accentKey] !== undefined) continue;
                  next[migration.accentKey] = migration.color;
                  changed = true;
                }
                return { next, changed };
              },
              persist: (projectAccentColors) =>
                persistAccentColors(patch.environmentId, projectAccentColors),
            });
            if (persisted === null) return;
            for (const migration of patch.migrations) {
              if (persisted[migration.accentKey] !== undefined) {
                consumedLegacyKeys.add(migration.legacyKey);
              }
            }
          }),
        );

        if (consumedLegacyKeys.size > 0) {
          const currentLegacyAccentColors = getClientSettings().sidebarProjectAccentColors;
          updateClientSettings({
            sidebarProjectAccentColors: Object.fromEntries(
              Object.entries(currentLegacyAccentColors).filter(
                ([legacyKey]) => !consumedLegacyKeys.has(legacyKey),
              ),
            ),
          });
        }
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [
    accentColorsByEnvironment,
    legacyAccentColors,
    persistAccentColors,
    projects,
    updateClientSettings,
    writableEnvironmentIds,
  ]);
}
