import type { ThreadEnvMode } from "@t3tools/contracts";

import type { T3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";

export interface InheritedEnvModeLabels {
  /** Trigger label while no project override is set. */
  readonly trigger: string;
  /** Label for the "inherit" option in the popup. */
  readonly inheritItem: string;
}

/**
 * Labels for the project "Workspace" default while no override is stored.
 *
 * The t3.json query settles after first render, so naming a source too early
 * would show "global" and then flip to "t3.json". Until the file query
 * settles, both labels stay a neutral "Default" with no provisional source.
 */
export function inheritedEnvModeLabels(input: {
  readonly status: T3ProjectFileState["status"];
  readonly fileEnvMode: ThreadEnvMode | null | undefined;
  readonly globalEnvMode: ThreadEnvMode;
}): InheritedEnvModeLabels {
  if (input.status === "loading") {
    return { trigger: "Default", inheritItem: "Default" };
  }
  const mode = input.fileEnvMode ?? input.globalEnvMode;
  const source = input.fileEnvMode != null ? "t3.json" : "global";
  const modeLabel = resolveEnvModeLabel(mode).toLowerCase();
  return {
    trigger: `Default (${modeLabel})`,
    inheritItem: `Default (${source}: ${modeLabel})`,
  };
}
