/**
 * Right-click file actions (reveal, open in editor, copy path) on the chip menu's machinery: reveal
 * rides `shell.openInEditor` with `reveal: true`, honored only with `shellRevealInFileManager`.
 * Launch actions run on the environment host, so they appear only when viewing from that host;
 * copying needs only the path and is offered everywhere.
 */
import {
  AuthOrchestrationOperateScope,
  buildRemoteOpenUrl,
  EDITORS,
  type ContextMenuItem,
  type EditorId,
  type EnvironmentId,
  type ServerConfig,
  type ContextMenuSource,
} from "@t3tools/contracts";

import { contextMenuSourceOf } from "./contextMenuSource";
import { resolveDiffPathForWorkspace } from "./diffFileActions";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "~/components/preview/fileExplorerLabel";
import { useEditorMenuIcons } from "./editorMenuIcons";
import { namedClipboardTarget, writeTextToClipboard } from "./hooks/useCopyToClipboard";
import { readLocalApi } from "./localApi";
import {
  openRemoteEditorUrl,
  type RemoteOpenMode,
  useRemoteCapableEditors,
  useRemoteOpenResolution,
} from "./remoteOpen";
import { serverEnvironment } from "./state/server";
import { useEnvironmentScope } from "./state/session";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { isAbsolutePath } from "@t3tools/shared/path";
import { toastManager } from "./components/ui/toast";
import { useAtomValue } from "@effect/atom-react";
import { msg, useMessages } from "gt-react";

import { m, type MessageResolver } from "./i18n/messages";

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
  readonly isDirectory?: boolean;
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

/**
 * Workspace-relative path for the target, the form the file tab and tree
 * show. A diff in a nested repository names files from the repository root,
 * so the workspace prefix comes off; a file surface already has the
 * workspace form. Null when the file lies outside the workspace.
 */
export function resolveFileContextMenuRelativePath(target: FileContextMenuTarget): string | null {
  if (target.absolutePath !== undefined) return target.filePath;
  return resolveDiffPathForWorkspace({
    filePath: target.filePath,
    workspaceRoot: target.workspaceRoot,
    repositoryRoot: target.repositoryRoot,
  });
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
  readonly editorIcons: ReadonlyMap<EditorId, string>;
  readonly resolve: MessageResolver;
}): readonly ContextMenuItem<FileContextMenuAction>[] {
  if (!input.hasAbsolutePath) return [];
  const items: ContextMenuItem<FileContextMenuAction>[] = [];
  if (input.capabilities.canOpenDefault) {
    items.push({
      id: "open",
      label: input.resolve(msg("Open", { $context: "verb, opens a file" })),
      icon: "pencil",
    });
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
      label: input.resolve(msg("Open with")),
      children: editorIds.map((editorId) => {
        const iconImage = input.editorIcons.get(editorId);
        return {
          id: `editor:${editorId}` as FileContextMenuAction,
          label: EDITOR_LABEL_BY_ID.get(editorId) ?? editorId,
          ...(iconImage === undefined ? {} : { iconImage }),
        };
      }),
    });
  }
  const separatorBefore = items.length > 0;
  if (input.hasRelativePath) {
    items.push({
      id: "copy-relative-path",
      label: input.resolve(msg("Copy relative path")),
      icon: "copy",
      separatorBefore,
    });
  }
  items.push({
    id: "copy-full-path",
    label: input.resolve(msg("Copy full path")),
    icon: "copy",
    separatorBefore: separatorBefore && !input.hasRelativePath,
  });
  return items;
}

/** Copies a file path and reports the outcome with the same toasts everywhere. */
export async function copyFilePathToClipboard(
  value: string,
  kind: FilePathCopyKind,
): Promise<void> {
  const noun = kind === "relative" ? "Relative path" : "Full path";
  let failure: string | null = null;
  try {
    // The clipboard helper returns false, rather than throwing, for an empty value.
    if (!(await writeTextToClipboard(value, namedClipboardTarget(noun.toLowerCase()))))
      failure = "The path is empty.";
  } catch (error) {
    failure = error instanceof Error ? error.message : m(msg("An error occurred."));
  }
  if (failure !== null) {
    toastManager.add({
      type: "error",
      title: m(
        kind === "relative" ? msg("Failed to copy relative path") : msg("Failed to copy full path"),
      ),
      description: failure,
    });
    return;
  }
  toastManager.add({ type: "success", title: `${noun} copied`, description: value });
}

/** Reveal wording, or undefined while hidden: unadvertised, viewer off-host, or not yet known (the
 * unresolved remote-open state defaults to local, so a remote environment would briefly offer it).
 * Server wording because WSL can reveal through Windows Explorer while reporting Linux. */
export function revealInFileManagerLabel(input: {
  readonly environmentId: EnvironmentId | null;
  readonly serverConfig: ServerConfig | null;
  readonly remoteOpenMode: RemoteOpenMode;
  readonly remoteOpenResolved: boolean;
  readonly resolve?: MessageResolver;
}): string | undefined {
  const { serverConfig } = input;
  if (
    input.environmentId === null ||
    !input.remoteOpenResolved ||
    input.remoteOpenMode !== "local-exec" ||
    serverConfig?.shellRevealInFileManager !== true ||
    !serverConfig.availableEditors.includes("file-manager")
  ) {
    return undefined;
  }
  return serverConfig.shellRevealInFileManagerKind === undefined
    ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os, input.resolve)
    : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind, input.resolve);
}

/**
 * Builds and dispatches the file context menu for one environment's files.
 * The environment id is fixed per component (a thread's environment, a file
 * browser's environment), so capabilities resolve once per hook call.
 */
export function useFileContextMenu(environmentId: EnvironmentId | null) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const resolve = useMessages();

  const remoteOpenMode = remoteOpen.state.mode;
  const remoteOpenResolved = remoteOpen.isResolved;
  const remoteCapableEditors = useRemoteCapableEditors();
  const mode = environmentId !== null && remoteOpenResolved ? remoteOpenMode : null;
  // Shell actions run on the server host, which is the viewer's machine only in local-exec.
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const isLocalExec = mode === "local-exec" && canOperateHost;
  const remoteHost = remoteOpen.state.mode === "remote-links" ? remoteOpen.state.host : null;
  const availableEditors = isLocalExec
    ? (serverConfig?.availableEditors ?? [])
    : mode === "remote-links"
      ? remoteCapableEditors
      : [];
  const capabilities: FileContextMenuCapabilities = {
    revealLabel: canOperateHost
      ? revealInFileManagerLabel({
          environmentId,
          serverConfig,
          remoteOpenMode,
          remoteOpenResolved,
          resolve,
        })
      : undefined,
    canOpenDefault: isLocalExec && availableEditors.includes("file-manager"),
    editorIds: availableEditors,
  };
  const editorIcons = useEditorMenuIcons(availableEditors);
  const buildItems = (target: FileContextMenuTarget) =>
    buildFileContextMenuItems({
      hasAbsolutePath: resolveFileContextMenuAbsolutePath(target) !== null,
      hasRelativePath: !isAbsolutePath(target.filePath),
      capabilities,
      editorIcons,
      resolve,
    });

  const editorFailureTitle = (editor: EditorId) =>
    resolve(
      msg("Could not open in {editor}", {
        editor: EDITOR_LABEL_BY_ID.get(editor) ?? editor,
      }),
    );

  const activate = async (
    action: FileContextMenuAction,
    target: FileContextMenuTarget,
  ): Promise<void> => {
    const absolutePath = resolveFileContextMenuAbsolutePath(target);
    if (absolutePath === null) return;

    // Copying needs only the path, so it runs without an environment.
    if (action === "copy-relative-path") {
      const relativePath = resolveFileContextMenuRelativePath(target);
      if (relativePath === null) return;
      await copyFilePathToClipboard(relativePath, "relative");
      return;
    }
    if (action === "copy-full-path") {
      await copyFilePathToClipboard(absolutePath, "full");
      return;
    }
    if (environmentId === null) return;

    const reveal = action === "reveal-in-folder";
    const editor =
      action === "open" || reveal
        ? ("file-manager" as const)
        : (action.slice("editor:".length) as EditorId);
    if (action === "open" && !capabilities.canOpenDefault) return;
    if (reveal && capabilities.revealLabel === undefined) return;
    if (action !== "open" && !reveal && !capabilities.editorIds.includes(editor)) return;

    if (remoteHost !== null) {
      const url = buildRemoteOpenUrl({
        editor,
        ...remoteHost,
        absolutePath,
        isFile: target.isDirectory !== true,
      });
      if (url !== undefined && (await openRemoteEditorUrl(url))) return;
      toastManager.add({
        type: "error",
        title: editorFailureTitle(editor),
        description: absolutePath,
      });
      return;
    }

    const result = await openInEditor({
      environmentId,
      input: { cwd: absolutePath, editor, ...(reveal ? { reveal: true } : {}) },
    });
    if (result._tag !== "Failure") return;
    toastManager.add({
      type: "error",
      title:
        action === "open"
          ? resolve(msg("Could not open file"))
          : reveal
            ? resolve(msg("Unable to reveal file"))
            : editorFailureTitle(editor),
      description: absolutePath,
    });
  };

  const show = async (
    target: FileContextMenuTarget,
    position?: { x: number; y: number },
    source?: ContextMenuSource,
  ): Promise<void> => {
    const api = readLocalApi();
    const items = buildItems(target);
    if (items.length === 0 || api === undefined) return;
    const clicked = await api.contextMenu.show(items, position, source);
    if (clicked === null) return;
    await activate(clicked as FileContextMenuAction, target);
  };

  return { buildItems, capabilities, activate, show };
}

/** Returns an onContextMenu callback that shows the menu at the pointer. */
export function useFileContextMenuHandler(environmentId: EnvironmentId | null) {
  const contextMenu = useFileContextMenu(environmentId);
  return (
    target: FileContextMenuTarget,
    event?: Pick<MouseEvent, "type" | "button" | "detail" | "clientX" | "clientY">,
  ) => {
    void contextMenu.show(
      target,
      event ? { x: event.clientX, y: event.clientY } : undefined,
      event ? contextMenuSourceOf(event) : undefined,
    );
  };
}
