import type {
  EnvironmentId,
  MessageInputOrigin,
  ModelSelection,
  OrchestrationMessageContext,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";

import type { DraftComposerAttachment } from "../lib/composerImages";

export interface ComposerDraft {
  readonly text: string;
  readonly inputOrigin?: MessageInputOrigin;
  readonly context?: OrchestrationMessageContext;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly importedShareIds?: ReadonlyArray<string>;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly workspaceSelection?: ComposerDraftWorkspaceSelection;
  /** New-task drafts store their project here so retargeting keeps the draft key. */
  readonly project?: ComposerDraftProject;
}

export interface ComposerDraftProject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly createdAt: string;
}

export interface ComposerDraftContent {
  readonly text: string;
  readonly inputOrigin?: MessageInputOrigin;
  readonly context?: OrchestrationMessageContext;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly sourceShareId?: string;
}

export interface ComposerDraftWorkspaceSelection {
  /** Undefined follows the resolved project, t3.json, or global default. */
  readonly mode?: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
}

export type ComposerDraftSettingsUpdate = Pick<
  ComposerDraft,
  "modelSelection" | "runtimeMode" | "interactionMode" | "workspaceSelection" | "project"
>;
