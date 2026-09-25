import {
  buildRemoteOpenUrl,
  EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenHint,
  useRemoteOpenState,
} from "../../remoteOpen";
import { useEnvironment } from "../../state/environments";
import {
  AppWindowIcon,
  ChevronDownIcon,
  CopyIcon,
  FolderClosedIcon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuTrigger,
} from "../ui/menu";
import {
  AntigravityIcon,
  CursorIcon,
  FileExplorerIcon,
  FinderIcon,
  Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import {
  type FileContextMenuAction,
  type FileContextMenuTarget,
  useFileContextMenu,
} from "../../fileContextMenu";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { useThreadPaneId } from "../thread-split/threadPaneContext";
import { isThreadPaneActive } from "../thread-split/threadSplitStore";

type OpenInOption = {
  label: string;
  Icon: Icon;
  value: EditorId;
  kind: "brand" | "generic";
};

/** The file context menu's actions the picker shows; open and open-with are the editor list. */
const FILE_PICKER_ACTIONS: ReadonlySet<FileContextMenuAction> = new Set<FileContextMenuAction>([
  "reveal-in-folder",
  "copy-relative-path",
  "copy-full-path",
]);

const fileManagerIconForPlatform = (platform: string) =>
  isMacPlatform(platform)
    ? FinderIcon
    : isWindowsPlatform(platform)
      ? FileExplorerIcon
      : FolderClosedIcon;

/**
 * The file-manager editor opens its target with the OS: a folder lands in
 * Finder, a file in whatever app owns its type. The option is labelled for
 * what the user gets, so a file surface calls it "Default app".
 */
export const resolveOpenInOptions = (
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
  target: "directory" | "file" = "directory",
) => {
  const baseOptions: ReadonlyArray<Omit<OpenInOption, "label">> = [
    {
      Icon: CursorIcon,
      value: "cursor",
      kind: "brand",
    },
    {
      Icon: TraeIcon,
      value: "trae",
      kind: "brand",
    },
    {
      Icon: KiroIcon,
      value: "kiro",
      kind: "brand",
    },
    {
      Icon: VisualStudioCode,
      value: "vscode",
      kind: "brand",
    },
    {
      Icon: VisualStudioCodeInsiders,
      value: "vscode-insiders",
      kind: "brand",
    },
    {
      Icon: VSCodium,
      value: "vscodium",
      kind: "brand",
    },
    {
      Icon: Zed,
      value: "zed",
      kind: "brand",
    },
    {
      Icon: AntigravityIcon,
      value: "antigravity",
      kind: "brand",
    },
    {
      Icon: IntelliJIdeaIcon,
      value: "idea",
      kind: "brand",
    },
    {
      Icon: AquaIcon,
      value: "aqua",
      kind: "brand",
    },
    {
      Icon: CLionIcon,
      value: "clion",
      kind: "brand",
    },
    {
      Icon: DataGripIcon,
      value: "datagrip",
      kind: "brand",
    },
    {
      Icon: DataSpellIcon,
      value: "dataspell",
      kind: "brand",
    },
    {
      Icon: GoLandIcon,
      value: "goland",
      kind: "brand",
    },
    {
      Icon: PhpStormIcon,
      value: "phpstorm",
      kind: "brand",
    },
    {
      Icon: PyCharmIcon,
      value: "pycharm",
      kind: "brand",
    },
    {
      Icon: RiderIcon,
      value: "rider",
      kind: "brand",
    },
    {
      Icon: RubyMineIcon,
      value: "rubymine",
      kind: "brand",
    },
    {
      Icon: RustRoverIcon,
      value: "rustrover",
      kind: "brand",
    },
    {
      Icon: WebStormIcon,
      value: "webstorm",
      kind: "brand",
    },
    target === "file"
      ? { Icon: AppWindowIcon, value: "file-manager", kind: "generic" }
      : {
          Icon: fileManagerIconForPlatform(platform),
          value: "file-manager",
          kind: isMacPlatform(platform) || isWindowsPlatform(platform) ? "brand" : "generic",
        },
  ];
  const availableEditorSet = new Set(availableEditors);
  return baseOptions
    .filter((option) => availableEditorSet.has(option.value))
    .map((option) => ({
      ...option,
      label:
        target === "file" && option.value === "file-manager"
          ? "Default app"
          : editorLabelForPlatform(option.value, platform),
    }));
};

function getOpenInIconClass(kind: OpenInOption["kind"]) {
  return cn(kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground");
}

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  fileRelativePath,
  presentation = "toolbar",
  compact = false,
  enableShortcut = true,
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  /**
   * Set when `openInCwd` is a file rather than a folder: relabels the
   * file-manager entry and appends reveal and copy-path actions for it. A
   * string, so the memoized picker still skips renders with unchanged props.
   */
  fileRelativePath?: string | undefined;
  presentation?: "toolbar" | "menu";
  compact?: boolean;
  enableShortcut?: boolean;
}) {
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const remote = useRemoteOpenState(environmentId);
  const remoteCapableEditors = useRemoteCapableEditors();
  const [remoteHintSeen, markRemoteHintSeen] = useRemoteOpenHint();
  const environmentLabel = useEnvironment(environmentId)?.label ?? "this machine";
  // Remote mode ignores the server's PATH probe: what matters is what runs on
  // the viewing machine, which only the desktop app can probe.
  const effectiveEditors = remote.mode === "local-exec" ? availableEditors : remoteCapableEditors;
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(effectiveEditors);
  const isFile = fileRelativePath !== undefined;
  const options = useMemo(
    () => resolveOpenInOptions(navigator.platform, effectiveEditors, isFile ? "file" : "directory"),
    [effectiveEditors, isFile],
  );
  // Reveal and copy act on the environment host, so they take the file's
  // resolved path as is; the picker never guesses it from a workspace root.
  const fileContextMenu = useFileContextMenu(isFile ? environmentId : null);
  const fileTarget: FileContextMenuTarget | null =
    fileRelativePath !== undefined && openInCwd
      ? {
          environmentId,
          filePath: fileRelativePath,
          workspaceRoot: undefined,
          absolutePath: openInCwd,
        }
      : null;
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      if (!openInCwd) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      if (remote.mode === "remote-unavailable") return;
      if (remote.mode === "remote-links") {
        const url = buildRemoteOpenUrl({
          editor,
          host: remote.host.host,
          absolutePath: openInCwd,
        });
        if (url === undefined) return;
        // Only record hint-seen/preferred when the shell actually accepted
        // the URL (an older desktop build can refuse the editor scheme).
        void openRemoteEditorUrl(url).then((opened) => {
          if (!opened) return;
          markRemoteHintSeen();
          setPreferredEditor(editor);
        });
        return;
      }
      const result = openInEditorMutation({
        environmentId,
        input: {
          cwd: openInCwd,
          editor,
        },
      });
      setPreferredEditor(editor);
      return result;
    },
    [
      environmentId,
      markRemoteHintSeen,
      openInCwd,
      openInEditorMutation,
      preferredEditor,
      remote,
      setPreferredEditor,
    ],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  const threadPaneId = useThreadPaneId();
  useEffect(() => {
    if (!enableShortcut) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      // Split view: both panes' headers mount this picker — only the active
      // pane's shortcut may open its cwd (possibly on another machine).
      if (!isThreadPaneActive(threadPaneId)) return;
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!openInCwd) return;
      if (!preferredEditor) return;

      e.preventDefault();
      void openInEditor(preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enableShortcut, keybindings, openInCwd, openInEditor, preferredEditor, threadPaneId]);

  const editorItems = (
    <>
      {remote.mode === "remote-unavailable" ? (
        <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
          No SSH route to {environmentLabel}
        </MenuItem>
      ) : (
        <>
          {options.length === 0 && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              No installed editors found
            </MenuItem>
          )}
          {options.map(({ label, Icon, value, kind }) => (
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}
              key={value}
              onClick={() => openInEditor(value)}
            >
              <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
              <MenuItemLabel>{label}</MenuItemLabel>
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
          {remote.mode === "remote-links" && !remoteHintSeen && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              Opens over SSH. Needs your key on {environmentLabel}
            </MenuItem>
          )}
        </>
      )}
    </>
  );
  const density = presentation === "menu" ? "touch" : "default";
  // Chosen once like `options`: the compiler lint rejects a component picked in render.
  const revealIcon = useMemo(() => {
    const platform = navigator.platform;
    return {
      Icon: fileManagerIconForPlatform(platform),
      kind: isMacPlatform(platform) || isWindowsPlatform(platform) ? "brand" : "generic",
    } as const;
  }, []);
  // The shared builder decides which file actions apply (reveal only on the
  // host, no relative path for a host file); the picker only adds icons.
  const fileMenuItems = fileTarget
    ? fileContextMenu.buildItems(fileTarget).filter((item) => FILE_PICKER_ACTIONS.has(item.id))
    : [];
  const fileItems =
    fileTarget && fileMenuItems.length > 0 ? (
      <>
        <MenuSeparator />
        {fileMenuItems.map((item) => (
          <MenuItem
            key={item.id}
            density={density}
            onClick={() => void fileContextMenu.activate(item.id, fileTarget)}
          >
            {item.id === "reveal-in-folder" ? (
              <revealIcon.Icon aria-hidden="true" className={getOpenInIconClass(revealIcon.kind)} />
            ) : (
              <CopyIcon aria-hidden="true" className={getOpenInIconClass("generic")} />
            )}
            <MenuItemLabel>{item.label}</MenuItemLabel>
          </MenuItem>
        ))}
      </>
    ) : null;

  if (presentation === "menu") {
    return (
      <>
        {primaryOption && (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}

            disabled={!openInCwd || remote.mode === "remote-unavailable"}
            onClick={() => openInEditor(preferredEditor)}
          >
            <primaryOption.Icon className={cn("size-4", getOpenInIconClass(primaryOption.kind))} />
            <MenuItemLabel>Open in {primaryOption.label}</MenuItemLabel>
            {openFavoriteEditorShortcutLabel && (
              <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
            )}
          </MenuItem>
        )}
        <MenuSub>
          <MenuSubTrigger density="touch">
            <SquareArrowOutUpRightIcon className="size-4" />
            <MenuItemLabel>Open in…</MenuItemLabel>
          </MenuSubTrigger>
          <MenuSubPopup>{editorItems}</MenuSubPopup>
        </MenuSub>
        {fileItems}
      </>
    );
  }

  return (
    <Group aria-label="Open in editor">
      <Button
        aria-label={compact ? "Open file in preferred editor" : undefined}
        size="xs"
        variant="outline"
        disabled={!preferredEditor || !openInCwd || remote.mode === "remote-unavailable"}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon && (
          <primaryOption.Icon
            aria-hidden="true"
            className={cn("size-3.5", getOpenInIconClass(primaryOption.kind))}
          />
        )}
        <span
          className={
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5"
          }
        >
          Open
        </span>
      </Button>
      <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      <Menu>
        <MenuTrigger
          render={<Button aria-label="Choose editor" size="icon-xs" variant="outline" />}
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {editorItems}
          {fileItems}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
