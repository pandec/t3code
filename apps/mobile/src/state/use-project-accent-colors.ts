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
 * Project accent colors as seen by mobile: read-only.
 *
 * They live in each server's settings, so the phone gets them for free from
 * the per-environment `ServerConfig` it already holds. That config is cached
 * on-device, so disconnected environments keep their last-known colors and a
 * cold launch does not have to wait for reconnects. Picking a color stays a
 * desktop/web affordance; mobile only renders what the servers report.
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
