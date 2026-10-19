/**
 * Web access to the cross-environment project accent colors.
 *
 * Accents are server settings (`ServerSettings.projectAccentColors`), one map
 * per environment, so the sidebar merges every connected environment on read
 * and fans a pick out to each environment owning a member of the group. See
 * `@t3tools/client-runtime/state/project-accent-colors` for the rules.
 */
import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
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
import { useStableCallback } from "./useStableCallback";
import {
  getClientSettings,
  useAccentTintSettings,
  useClientSettings,
  updateClientSettings,
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
}

/** The latest committed map, for queued writes that read it after an await. */
function useReadCurrentAccentColors(
  accentColorsByEnvironment: ReadonlyMap<EnvironmentId, ProjectAccentColorMap>,
) {
  return useStableCallback((environmentId: EnvironmentId) =>
    accentColorsByEnvironment.get(environmentId),
  );
}

function usePersistProjectAccentColors() {
  const updateEnvironmentSettings = useUpdateSettingsForEnvironment();
  return async (
    environmentId: EnvironmentId,
    projectAccentColors: Record<string, SidebarProjectAccentColor>,
  ): Promise<ProjectAccentColorMap | null> => {
    const result = await updateEnvironmentSettings(environmentId, { projectAccentColors });
    return result?._tag === "Success" ? result.value.projectAccentColors : null;
  };
}

function useFillProjectAccentColors() {
  const updateEnvironmentSettings = useUpdateSettingsForEnvironment();
  return async (
    environmentId: EnvironmentId,
    projectAccentColorsFill: Record<string, SidebarProjectAccentColor>,
  ): Promise<ProjectAccentColorMap | null> => {
    const result = await updateEnvironmentSettings(environmentId, {
      projectAccentColorsFill,
    });
    return result?._tag === "Success" ? result.value.projectAccentColors : null;
  };
}

export function useProjectAccentColors(): ProjectAccentColors {
  const { accentColorsByEnvironment, writableEnvironmentIds } = useAccentEnvironmentState();
  const persistAccentColors = usePersistProjectAccentColors();
  const readCurrentAccentColors = useReadCurrentAccentColors(accentColorsByEnvironment);

  const resolve = (members: ReadonlyArray<ProjectAccentSource>) =>
    resolveProjectAccentColor({
      members: toProjectAccentMembers(members),
      accentColorsByEnvironment,
    });

  const update = (
    members: ReadonlyArray<ProjectAccentSource>,
    color: SidebarProjectAccentColor | null,
  ) => {
    const accentKeysByEnvironment = collectWritableProjectAccentKeys({
      members: toProjectAccentMembers(members),
      accentColorsByEnvironment,
      writableEnvironmentIds,
    });
    for (const [environmentId, accentKeys] of accentKeysByEnvironment) {
      void enqueueProjectAccentColorWrite({
        environmentId,
        fallbackMap: accentColorsByEnvironment.get(environmentId) ?? {},
        readCurrentMap: () => readCurrentAccentColors(environmentId),
        update: (current) => {
          const { next, changed } = withProjectAccentKeys(current, accentKeys, color);
          return { payload: next, changed };
        },
        persist: (projectAccentColors) => persistAccentColors(environmentId, projectAccentColors),
      });
    }
  };

  const clearAllServerColors = () => {
    for (const environmentId of writableEnvironmentIds) {
      const current = accentColorsByEnvironment.get(environmentId) ?? {};
      void enqueueProjectAccentColorWrite({
        environmentId,
        fallbackMap: current,
        readCurrentMap: () => readCurrentAccentColors(environmentId),
        update: () => ({
          payload: {},
          changed: true,
        }),
        persist: (projectAccentColors) => persistAccentColors(environmentId, projectAccentColors),
      });
    }
  };

  const hasAnyServerAccentColors = [...accentColorsByEnvironment.values()].some(
    (accentColors) => Object.keys(accentColors).length > 0,
  );

  return { resolve, update, clearAllServerColors, hasAnyServerAccentColors };
}

/**
 * Row tint per member project, keyed `environmentId:projectId`. Empty while
 * tints are switched off, so every tinted surface follows the toggle; the
 * accents themselves stay untouched.
 */
export function useProjectAccentColorByKey(
  groups: ReadonlyArray<{
    readonly memberProjects: ReadonlyArray<ProjectAccentSource>;
    readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
  }>,
): ReadonlyMap<string, SidebarProjectAccentColor> {
  const { resolve } = useProjectAccentColors();
  const { enabled } = useAccentTintSettings();
  return new Map(
    enabled
      ? groups.flatMap((group) => {
          const color = resolve(group.memberProjects);
          return color === null
            ? []
            : group.memberProjectRefs.map(
                (projectRef) =>
                  [`${projectRef.environmentId}:${projectRef.projectId}`, color] as const,
              );
        })
      : [],
  );
}

/** Writes one migration plan and drops the legacy entries that landed; true when some did not. */
async function runProjectAccentColorMigration({
  plan,
  accentColorsByEnvironment,
  readCurrentMap,
  fillProjectAccentColors,
}: {
  readonly plan: ReturnType<typeof planProjectAccentColorMigration>;
  readonly accentColorsByEnvironment: ReadonlyMap<EnvironmentId, ProjectAccentColorMap>;
  readonly readCurrentMap: (environmentId: EnvironmentId) => ProjectAccentColorMap | undefined;
  readonly fillProjectAccentColors: ReturnType<typeof useFillProjectAccentColors>;
}): Promise<boolean> {
  const consumedLegacyKeys = new Set(plan.consumedWithoutWrite);
  let retryNeeded = false;
  await Promise.all(
    plan.patches.map(async (patch) => {
      const persisted = await enqueueProjectAccentColorWrite({
        environmentId: patch.environmentId,
        fallbackMap: accentColorsByEnvironment.get(patch.environmentId) ?? {},
        readCurrentMap: () => readCurrentMap(patch.environmentId),
        update: (current) => ({
          payload: patch.projectAccentColorsFill,
          changed: patch.migrations.some((migration) => current[migration.accentKey] === undefined),
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
  return retryNeeded;
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
  const readCurrentAccentColors = useReadCurrentAccentColors(accentColorsByEnvironment);
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
    void runProjectAccentColorMigration({
      plan,
      accentColorsByEnvironment,
      readCurrentMap: readCurrentAccentColors,
      fillProjectAccentColors,
    })
      .then((retryNeeded) => {
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
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [
    accentColorsByEnvironment,
    fillProjectAccentColors,
    legacyAccentColors,
    fillCapableEnvironmentIds,
    projects,
    readCurrentAccentColors,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A retry bump re-runs the migration for the writes that did not land.
    retryGeneration,
  ]);
}
