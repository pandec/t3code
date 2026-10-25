import { PullRequestContextMetadata } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { Option, Schema } from "effect";

export const COMPOSER_MENTION_DRAG_TYPE = "application/x-t3code-composer-mention";

/** Drag scope: `environmentId` or `environmentId:projectId`. Mentions are workspace-relative, so a
 * split-view drop into another workspace's composer would mention a missing file. Project, not cwd,
 * granularity (worktree-aware cwds differ within one thread); when either side lacks a project,
 * only the environment is compared. */
export const COMPOSER_MENTION_DRAG_SCOPE_TYPE = "application/x-t3code-composer-mention-scope";

function parseComposerMentionScope(scope: string): {
  environmentId: string;
  projectId: string | null;
} {
  const separatorIndex = scope.indexOf(":");
  return separatorIndex === -1
    ? { environmentId: scope, projectId: null }
    : {
        environmentId: scope.slice(0, separatorIndex),
        projectId: scope.slice(separatorIndex + 1),
      };
}

export function composerMentionScopeMismatch(dragScope: string, hostScope: string): boolean {
  const drag = parseComposerMentionScope(dragScope);
  const host = parseComposerMentionScope(hostScope);
  if (drag.environmentId !== host.environmentId) {
    return true;
  }
  return drag.projectId !== null && host.projectId !== null && drag.projectId !== host.projectId;
}

export const COMPOSER_PULL_REQUEST_DRAG_TYPE = "application/x-t3code-pull-request";

const PullRequestDragPayload = Schema.fromJsonString(PullRequestContextMetadata);
const decodePullRequestPayload = Schema.decodeUnknownOption(PullRequestDragPayload);

export const encodePullRequestDragPayload = Schema.encodeSync(PullRequestDragPayload);

export function composerMentionFromTreePath(treePath: string): string | null {
  const relativePath = treePath.replace(/\/+$/, "");
  if (relativePath.length === 0) {
    return null;
  }
  return serializeComposerFileLink(relativePath);
}

export function dataTransferHasComposerMention(types: ReadonlyArray<string>): boolean {
  return (
    types.includes(COMPOSER_MENTION_DRAG_TYPE) || types.includes(COMPOSER_PULL_REQUEST_DRAG_TYPE)
  );
}

export interface ComposerMentionDragTransfer {
  readonly types: ReadonlyArray<string>;
  getData(format: string): string;
  dropEffect: string;
}

export interface ComposerMentionDragEvent {
  readonly dataTransfer: ComposerMentionDragTransfer;
  readonly nativeEvent: { stopPropagation(): void };
  preventDefault(): void;
  stopPropagation(): void;
}

/** Insertion focuses next frame; synchronous focus would overwrite the unreconciled mention. */
export interface ComposerMentionDropHost {
  /** Scope the composer targets (`env` or `env:projectId`); mismatched drops are declined. */
  mentionScope?: string | null;
  insertMentionAtEnd(text: string): boolean;
  insertPullRequestAtEnd(pullRequest: PullRequestContextMetadata): boolean;
  setDragActive(active: boolean): void;
  onInsertRejected(): void;
  onScopeMismatch?(): void;
}

export interface ComposerMentionDragHandlers {
  onDragEnter(event: ComposerMentionDragEvent): void;
  onDragOver(event: ComposerMentionDragEvent): void;
  onDrop(event: ComposerMentionDragEvent): void;
}

export function makeComposerMentionDragHandlers(
  host: ComposerMentionDropHost,
): ComposerMentionDragHandlers {
  // Stop native propagation so the editor cannot process claimed drags.
  const claim = (event: ComposerMentionDragEvent): boolean => {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopPropagation();
    return true;
  };
  return {
    onDragEnter(event) {
      if (claim(event)) {
        host.setDragActive(true);
      }
    },
    onDragOver(event) {
      if (!claim(event)) {
        return;
      }
      // Tree drags allow only "move"; other drop effects cancel delivery.
      event.dataTransfer.dropEffect = "move";
      host.setDragActive(true);
    },
    onDrop(event) {
      if (!claim(event)) {
        return;
      }
      host.setDragActive(false);
      if (event.dataTransfer.types.includes(COMPOSER_PULL_REQUEST_DRAG_TYPE)) {
        const pullRequest = decodePullRequestPayload(
          event.dataTransfer.getData(COMPOSER_PULL_REQUEST_DRAG_TYPE),
        );
        if (Option.isSome(pullRequest) && !host.insertPullRequestAtEnd(pullRequest.value)) {
          host.onInsertRejected();
        }
        return;
      }
      const mention = event.dataTransfer.getData(COMPOSER_MENTION_DRAG_TYPE);
      if (mention.length === 0) {
        return;
      }
      const dragScope = event.dataTransfer.getData(COMPOSER_MENTION_DRAG_SCOPE_TYPE);
      if (
        host.mentionScope &&
        dragScope.length > 0 &&
        composerMentionScopeMismatch(dragScope, host.mentionScope)
      ) {
        host.onScopeMismatch?.();
        return;
      }
      if (!host.insertMentionAtEnd(`${mention} `)) {
        host.onInsertRejected();
      }
    },
  };
}
