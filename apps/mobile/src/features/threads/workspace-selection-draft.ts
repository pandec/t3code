import type { ComposerDraftWorkspaceSelection } from "../../state/use-composer-drafts";

/**
 * Builds the workspace selection written by controls that edit worktree
 * metadata — branch, worktree path, start-from-origin — rather than the mode
 * itself.
 *
 * Those controls must never persist a mode of their own. The mode they see is
 * usually the resolved default (project setting → t3.json → global), which is
 * provisional while t3.json is still loading and must keep tracking the
 * setting even after it settles. Writing it back would freeze it into the
 * draft as an explicit pick, so a branch tap would silently decide the
 * thread's environment mode. Only a mode the user actually chose is carried
 * across; otherwise the field is omitted and the draft keeps resolving it.
 */
export function workspaceMetadataSelection(input: {
  readonly explicitMode: ComposerDraftWorkspaceSelection["mode"];
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin: boolean | undefined;
}): ComposerDraftWorkspaceSelection {
  return {
    ...(input.explicitMode !== undefined ? { mode: input.explicitMode } : {}),
    branch: input.branch,
    worktreePath: input.worktreePath,
    ...(input.startFromOrigin !== undefined ? { startFromOrigin: input.startFromOrigin } : {}),
  };
}
