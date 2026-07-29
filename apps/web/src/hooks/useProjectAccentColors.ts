/**
 * Web access to the cross-environment project accent colors.
 *
 * Accents are server settings (`ServerSettings.projectAccentColors`), one map
 * per environment, so the sidebar merges every connected environment on read
 * and fans a pick out to each environment owning a member of the group. See
 * `@t3tools/client-runtime/state/project-accent-colors` for the rules.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /** Clears every connected server map. */
  readonly clearAllServerColors: () => void;
  readonly hasAnyServerAccentColors: boolean;
}

interface AccentEnvironmentState {
  readonly accentColorsByEnvironment: ReadonlyMap<EnvironmentId, ProjectAccentColorMap>;
  readonly writableEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly fillCapableEnvironmentIds: ReadonlySet<EnvironmentId>;
}

function useAccentEnvironmentState(): AccentEnvironmentState {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  return useMemo(() => {
    const accentColorsByEnvironment = new Map<EnvironmentId, ProjectAccentColorMap>();
    const writableEnvironmentIds = new Set<EnvironmentId>();
    const fillCapableEnvironmentIds = new Set<EnvironmentId>();
    for (const [environmentId, presentation] of presentations) {
      const config = presentation.serverConfig;
      if (presentation.connection.phase !== "connected" || config === null) continue;
      accentColorsByEnvironment.set(environmentId, config.settings.projectAccentColors);
      if (config.environment.capabilities.projectAccentColors === true) {
        writableEnvironmentIds.add(environmentId);
      }
      if (config.environment.capabilities.projectAccentColorsFill === true) {
        fillCapableEnvironmentIds.add(environmentId);
      }
    }
    return { accentColorsByEnvironment, writableEnvironmentIds, fillCapableEnvironmentIds };
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

function useFillProjectAccentColors() {
  const updateEnvironmentSettings = useUpdateSettingsForEnvironment();
  return useCallback(
    async (
      environmentId: EnvironmentId,
      projectAccentColorsFill: Record<string, SidebarProjectAccentColor>,
    ): Promise<ProjectAccentColorMap | null> => {
      const result = await updateEnvironmentSettings(environmentId, {
        projectAccentColorsFill,
      });
      return result?._tag === "Success" ? result.value.projectAccentColors : null;
    },
    [updateEnvironmentSettings],
  );
}

export function useProjectAccentColors(): ProjectAccentColors {
  const { accentColorsByEnvironment, writableEnvironmentIds } = useAccentEnvironmentState();
  const persistAccentColors = usePersistProjectAccentColors();
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
          update: (current) => {
            const { next, changed } = withProjectAccentKeys(current, accentKeys, color);
            return { payload: next, changed };
          },
          persist: (projectAccentColors) => persistAccentColors(environmentId, projectAccentColors),
        });
      }
    },
    [accentColorsByEnvironment, persistAccentColors, writableEnvironmentIds],
  );

  const clearAllServerColors = useCallback(() => {
    for (const environmentId of writableEnvironmentIds) {
      const current = accentColorsByEnvironment.get(environmentId) ?? {};
      void enqueueProjectAccentColorWrite({
        environmentId,
        fallbackMap: current,
        readCurrentMap: () => accentColorsRef.current.get(environmentId),
        update: (latest) => ({
          payload: {},
          changed: Object.keys(latest).length > 0,
        }),
        persist: (projectAccentColors) => persistAccentColors(environmentId, projectAccentColors),
      });
    }
  }, [accentColorsByEnvironment, persistAccentColors, writableEnvironmentIds]);

  const hasAnyServerAccentColors = useMemo(
    () =>
      [...accentColorsByEnvironment.values()].some(
        (accentColors) => Object.keys(accentColors).length > 0,
      ),
    [accentColorsByEnvironment],
  );

  return useMemo(
    () => ({ resolve, update, clearAllServerColors, hasAnyServerAccentColors }),
    [clearAllServerColors, hasAnyServerAccentColors, resolve, update],
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
  const { accentColorsByEnvironment, fillCapableEnvironmentIds } = useAccentEnvironmentState();
  const legacyAccentColors = useClientSettings((settings) => settings.sidebarProjectAccentColors);
  const fillProjectAccentColors = useFillProjectAccentColors();
  const updateClientSettings = useUpdateClientSettings();
  const accentColorsRef = useRef(accentColorsByEnvironment);
  accentColorsRef.current = accentColorsByEnvironment;
  // One in-flight migration at a time: the server patches are async, so a
  // re-render before they land would otherwise re-send the same writes.
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1_000);
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimeoutRef.current !== null) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (inFlightRef.current) return;
    if (Object.keys(legacyAccentColors).length === 0) return;

    const plan = planProjectAccentColorMigration({
      clientAccentColors: legacyAccentColors,
      projects,
      accentColorsByEnvironment,
      fillCapableEnvironmentIds,
      deriveLegacyKey: derivePhysicalProjectKey,
    });
    if (plan.patches.length === 0 && plan.consumedWithoutWrite.length === 0) return;

    inFlightRef.current = true;
    void (async () => {
      const consumedLegacyKeys = new Set(plan.consumedWithoutWrite);
      let retryNeeded = false;
      try {
        await Promise.all(
          plan.patches.map(async (patch) => {
            const persisted = await enqueueProjectAccentColorWrite({
              environmentId: patch.environmentId,
              fallbackMap: accentColorsByEnvironment.get(patch.environmentId) ?? {},
              readCurrentMap: () => accentColorsRef.current.get(patch.environmentId),
              update: (current) => ({
                payload: patch.projectAccentColorsFill,
                changed: patch.migrations.some(
                  (migration) => current[migration.accentKey] === undefined,
                ),
              }),
              persist: (projectAccentColorsFill) =>
                fillProjectAccentColors(patch.environmentId, projectAccentColorsFill),
            });
            if (persisted === null) {
              retryNeeded = true;
              return;
            }
            for (const migration of patch.migrations) {
              if (persisted[migration.accentKey] !== undefined) {
                consumedLegacyKeys.add(migration.legacyKey);
              } else {
                retryNeeded = true;
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

        if (retryNeeded && mountedRef.current && retryTimeoutRef.current === null) {
          const retryDelay = retryDelayRef.current;
          retryDelayRef.current = Math.min(retryDelay * 2, 30_000);
          retryTimeoutRef.current = setTimeout(() => {
            retryTimeoutRef.current = null;
            if (mountedRef.current) {
              setRetryGeneration((generation) => generation + 1);
            }
          }, retryDelay);
        } else if (!retryNeeded) {
          retryDelayRef.current = 1_000;
          if (retryTimeoutRef.current !== null) {
            clearTimeout(retryTimeoutRef.current);
            retryTimeoutRef.current = null;
          }
        }
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [
    accentColorsByEnvironment,
    fillProjectAccentColors,
    legacyAccentColors,
    fillCapableEnvironmentIds,
    projects,
    retryGeneration,
    updateClientSettings,
  ]);
}
