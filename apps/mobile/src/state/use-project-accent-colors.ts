import { useAtomValue } from "@effect/atom-react";
import {
  resolveProjectAccentColor,
  toProjectAccentMembers,
  type ProjectAccentSource,
} from "@t3tools/client-runtime/state/project-accent-colors";
import type { SidebarProjectAccentColor } from "@t3tools/contracts/settings";
import { useCallback, useMemo } from "react";

import { projectAccentColorsFromServerConfigs } from "./project-accent-colors-from-server-configs";
import { environmentServerConfigsAtom } from "./server";

/**
 * Read-only: colors come from each environment's cached `ServerConfig`, so disconnected
 * environments keep their last-known colors. No primary environment is passed (mobile has no
 * local server). The tint opt-out gates the wash at `resolveRowAccentTintAlpha`, not here, so the
 * group-header dot survives it.
 */
export function useProjectAccentColors(): (
  members: ReadonlyArray<ProjectAccentSource>,
) => SidebarProjectAccentColor | null {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const accentColorsByEnvironment = useMemo(
    () => projectAccentColorsFromServerConfigs(serverConfigs),
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
