import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { ProjectAccentColorMap } from "@t3tools/client-runtime/state/project-accent-colors";
import type { EnvironmentId } from "@t3tools/contracts";

/**
 * The latest accent map for every catalog environment whose server config has
 * hydrated. Server configs already have a schema-validated SQLite cache that
 * survives disconnects and is cleared when the environment leaves the catalog,
 * so accent colors should reuse that lifecycle instead of maintaining a second
 * storage copy.
 */
export function projectAccentColorsFromPresentations(
  presentations: ReadonlyMap<EnvironmentId, Pick<EnvironmentPresentation, "serverConfig">>,
): ReadonlyMap<EnvironmentId, ProjectAccentColorMap> {
  return new Map(
    [...presentations].flatMap(([environmentId, presentation]) =>
      presentation.serverConfig !== null
        ? [[environmentId, presentation.serverConfig.settings.projectAccentColors] as const]
        : [],
    ),
  );
}
