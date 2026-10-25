import type { ComposerDraftWorkspaceSelection } from "../../state/use-composer-drafts";

/**
 * Controls that edit worktree metadata must never persist a mode of their own: the mode they see
 * is usually the provisional resolved default, and writing it back would freeze it into the draft
 * as an explicit pick. Only a mode the user chose is carried; otherwise the field is omitted.
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
