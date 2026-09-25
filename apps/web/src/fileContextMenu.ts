/**
 * Right-click actions for a workspace file: reveal it in the environment's
 * file manager, open it in an editor, and copy its path. Reuse the chat
 * file-chip menu's machinery: reveal rides `shell.openInEditor` with
 * `reveal: true`, which the server only honors when its
 * `shellRevealInFileManager` config flag is set, so both actions work for
 * every client. Reveal is offered only while the viewing machine is the
 * environment host; revealing a folder on another computer helps nobody.
 */
import {
  EDITORS,
  type ContextMenuItem,
  type EditorId,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { resolveDiffPathForWorkspace } from "./diffFileActions";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "~/components/preview/fileExplorerLabel";
import { writeTextToClipboard } from "./hooks/useCopyToClipboard";
import { readLocalApi } from "./localApi";
import { type RemoteOpenMode, useRemoteOpenState } from "./remoteOpen";
import { serverEnvironment } from "./state/server";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { isAbsolutePath, resolvePathLinkTarget } from "./terminal-links";
import { toastManager } from "./components/ui/toast";
import { useAtomValue } from "@effect/atom-react";

export type FileContextMenuAction =
  | "reveal-in-folder"
  | "open"
  /** Submenu parent; never the activated id. */
  | "open-with"
  | `editor:${EditorId}`
  | "copy-relative-path"
  | "copy-full-path";

export type FilePathCopyKind = "relative" | "full";

export interface FileContextMenuTarget {
  readonly environmentId: EnvironmentId | null;
  /** Repo- or workspace-relative file path, as shown in diffs. */
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot?: string | undefined;
  /**
   * Already-resolved path on the environment host. File surfaces know it (a
   * host file's `filePath` is itself absolute, which diff-style resolution
   * rejects), so they pass it instead of resolving again.
   */
  readonly absolutePath?: string | undefined;
}

/**
 * Absolute path on the environment host for a diff-style target, resolving
 * repo-relative paths through the workspace root like every other diff
 * surface. Returns null when the path cannot be resolved, which callers must
 * treat as "no file actions available".
 */
export function resolveFileContextMenuAbsolutePath(target: FileContextMenuTarget): string | null {
  if (target.absolutePath !== undefined) return target.absolutePath;
  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath: target.filePath,
    workspaceRoot: target.workspaceRoot,
    repositoryRoot: target.repositoryRoot,
  });
  if (workspaceFilePath === null) return null;
  if (target.workspaceRoot === undefined) {
    return workspaceFilePath.startsWith("/") || /^[a-zA-Z]:/.test(workspaceFilePath)
      ? workspaceFilePath
      : null;
  }
  return resolvePathLinkTarget(workspaceFilePath, target.workspaceRoot);
}

const EDITOR_LABEL_BY_ID = new Map(EDITORS.map((editor) => [editor.id, editor.label]));

export interface FileContextMenuCapabilities {
  readonly revealLabel: string | undefined;
  readonly canOpenDefault: boolean;
  readonly editorIds: ReadonlyArray<EditorId>;
}

/**
 * Menu items for a resolved file: default-app open, reveal (with
 * server-provided wording), and an "Open with" submenu, each offered only when
 * the environment's config advertises it, then the copy-path pair. Empty
 * without an absolute path, since nothing here can act on the file.
 */
export function buildFileContextMenuItems(input: {
  readonly hasAbsolutePath: boolean;
  /** False for a host file, whose only path is the full one. */
  readonly hasRelativePath: boolean;
  readonly capabilities: FileContextMenuCapabilities;
}): readonly ContextMenuItem<FileContextMenuAction>[] {
  if (!input.hasAbsolutePath) return [];
  const items: ContextMenuItem<FileContextMenuAction>[] = [];
  if (input.capabilities.canOpenDefault) {
    items.push({ id: "open", label: "Open", icon: "pencil" });
  }
  if (input.capabilities.revealLabel !== undefined) {
    items.push({
      id: "reveal-in-folder",
      label: input.capabilities.revealLabel,
      icon: "folder-tree",
    });
  }
  const editorIds = input.capabilities.editorIds.filter((id) => id !== "file-manager");
  if (editorIds.length > 0) {
    items.push({
      id: "open-with",
      label: "Open with",
      children: editorIds.map((editorId) => ({
        id: `editor:${editorId}` as FileContextMenuAction,
        label: EDITOR_LABEL_BY_ID.get(editorId) ?? editorId,
      })),
    });
  }
  const separatorBefore = items.length > 0;
  if (input.hasRelativePath) {
    items.push({
      id: "copy-relative-path",
      label: filePathCopyLabel("relative"),
      icon: "copy",
      separatorBefore,
    });
  }
  items.push({
    id: "copy-full-path",
    label: filePathCopyLabel("full"),
    icon: "copy",
    separatorBefore: separatorBefore && !input.hasRelativePath,
  });
  return items;
}

export function filePathCopyLabel(kind: FilePathCopyKind): string {
  return kind === "relative" ? "Copy relative path" : "Copy full path";
}

/** Copies a file path and reports the outcome with the same toasts everywhere. */
export async function copyFilePathToClipboard(
  value: string,
  kind: FilePathCopyKind,
): Promise<void> {
  const noun = kind === "relative" ? "Relative path" : "Full path";
  try {
    await writeTextToClipboard(value, noun.toLowerCase());
    toastManager.add({ type: "success", title: `${noun} copied`, description: value });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: `Failed to copy ${noun.toLowerCase()}`,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}

/**
 * Wording for the reveal action, or undefined when it must stay hidden: the
 * server does not advertise it, or the viewer is not on the host machine. The
 * wording comes from the server because on WSL the reveal can run through
 * Windows File Explorer even though the host reports Linux.
 */
export function revealInFileManagerLabel(input: {
  readonly environmentId: EnvironmentId | null;
  readonly serverConfig: ServerConfig | null;
  readonly remoteOpenMode: RemoteOpenMode;
}): string | undefined {
  const { serverConfig } = input;
  if (
    input.environmentId === null ||
    input.remoteOpenMode !== "local-exec" ||
    serverConfig?.shellRevealInFileManager !== true ||
    !serverConfig.availableEditors.includes("file-manager")
  ) {
    return undefined;
  }
  return serverConfig.shellRevealInFileManagerKind === undefined
    ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
    : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind);
}

export function useRevealInFileManagerLabel(environmentId: EnvironmentId | null) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const remoteOpenMode = useRemoteOpenState(environmentId).mode;
  return revealInFileManagerLabel({ environmentId, serverConfig, remoteOpenMode });
}

/**
 * Builds and dispatches the file context menu for one environment's files.
 * The environment id is fixed per component (a thread's environment, a file
 * browser's environment), so capabilities resolve once per hook call.
 */
export function useFileContextMenu(environmentId: EnvironmentId | null) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const revealLabel = useRevealInFileManagerLabel(environmentId);

  return useMemo(() => {
    const availableEditors = serverConfig?.availableEditors ?? [];
    const capabilities: FileContextMenuCapabilities = {
      revealLabel,
      canOpenDefault: availableEditors.includes("file-manager"),
      editorIds: availableEditors,
    };
    const buildItems = (target: FileContextMenuTarget) =>
      buildFileContextMenuItems({
        hasAbsolutePath: resolveFileContextMenuAbsolutePath(target) !== null,
        hasRelativePath: !isAbsolutePath(target.filePath),
        capabilities,
      });

    const activate = async (
      action: FileContextMenuAction,
      target: FileContextMenuTarget,
    ): Promise<void> => {
      const absolutePath = resolveFileContextMenuAbsolutePath(target);
      if (absolutePath === null || environmentId === null) return;

      if (action === "copy-relative-path") {
        await copyFilePathToClipboard(target.filePath, "relative");
        return;
      }
      if (action === "copy-full-path") {
        await copyFilePathToClipboard(absolutePath, "full");
        return;
      }

      const reveal = action === "reveal-in-folder";
      const editor =
        action === "open" || reveal
          ? ("file-manager" as const)
          : (action.slice("editor:".length) as EditorId);
      if (action !== "open" && !reveal && !capabilities.editorIds.includes(editor)) return;

      const result = await openInEditor({
        environmentId,
        input: { cwd: absolutePath, editor, ...(reveal ? { reveal: true } : {}) },
      });
      if (result._tag !== "Failure") return;
      toastManager.add({
        type: "error",
        title:
          action === "open"
            ? "Could not open file"
            : reveal
              ? "Unable to reveal file"
              : `Could not open in ${EDITOR_LABEL_BY_ID.get(editor) ?? editor}`,
        description: absolutePath,
      });
    };

    const show = async (
      target: FileContextMenuTarget,
      position?: { x: number; y: number },
    ): Promise<void> => {
      const api = readLocalApi();
      const items = buildItems(target);
      if (items.length === 0 || api === undefined) return;
      const clicked = await api.contextMenu.show(items, position);
      if (clicked === null) return;
      await activate(clicked as FileContextMenuAction, target);
    };

    return { buildItems, capabilities, activate, show };
  }, [environmentId, openInEditor, revealLabel, serverConfig]);
}

/** Returns an onContextMenu callback that shows the menu at the pointer. */
export function useFileContextMenuHandler(environmentId: EnvironmentId | null) {
  const contextMenu = useFileContextMenu(environmentId);
  return useCallback(
    (target: FileContextMenuTarget, event?: { clientX: number; clientY: number }) => {
      void contextMenu.show(target, event ? { x: event.clientX, y: event.clientY } : undefined);
    },
    [contextMenu],
  );
}
