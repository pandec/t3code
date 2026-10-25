import type { ProjectAccentColorMap } from "@t3tools/client-runtime/state/project-accent-colors";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

/**
 * Reuses the server-config SQLite cache, which survives disconnects and is cleared when the
 * environment leaves the catalog, instead of keeping a second storage copy of accent colors.
 */
export function projectAccentColorsFromServerConfigs(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): ReadonlyMap<EnvironmentId, ProjectAccentColorMap> {
  return new Map(
    [...serverConfigs].map(
      ([environmentId, serverConfig]) =>
        [environmentId, serverConfig.settings.projectAccentColors] as const,
    ),
  );
}
