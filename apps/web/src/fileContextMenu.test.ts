import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as NodeAssert from "node:assert/strict";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildFileContextMenuItems,
  resolveFileContextMenuAbsolutePath,
  resolveFileContextMenuRelativePath,
  revealInFileManagerLabel,
  useFileContextMenu,
} from "./fileContextMenu";
import { m } from "./i18n/messages";
import type { RemoteOpenResolution } from "./remoteOpen";

const state = vi.hoisted(() => ({
  remoteOpen: { state: { mode: "local-exec" }, isResolved: true } as RemoteOpenResolution,
  openInEditor: vi.fn(async () => ({ _tag: "Success" })),
  openRemoteEditorUrl: vi.fn(async (_url: string) => true),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    availableEditors: ["cursor", "file-manager"],
    shellRevealInFileManager: true,
    shellRevealInFileManagerKind: "xdg-open",
    environment: { platform: { os: "linux" } },
  }),
}));
vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useMessages: () => (text: string) => text,
}));
vi.mock(import("./state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock("./editorMenuIcons", () => ({ useEditorMenuIcons: () => new Map() }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => state.openInEditor }));
vi.mock(import("./remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => state.remoteOpen,
  useRemoteCapableEditors: () => ["vscode"],
  openRemoteEditorUrl: state.openRemoteEditorUrl,
}));

const BASE_TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};

const NO_EDITOR_ICONS = new Map();

const EMPTY_CAPABILITIES = {
  revealLabel: undefined,
  canOpenDefault: false,
  editorIds: [],
};

describe("resolveFileContextMenuAbsolutePath", () => {
  it("strips the repository prefix when the repo root is nested in the workspace", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "packages/app/src/index.ts",
      }),
    ).toBe("/workspace/project/packages/app/src/index.ts");
  });

  it("returns null for paths outside the workspace when a repository root is set", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "other/src/index.ts",
      }),
    ).toBeNull();
  });

  it("rejects absolute paths without a workspace root, matching diff path resolution", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: undefined,
        filePath: "/absolute/src/index.ts",
      }),
    ).toBeNull();
  });

  it("trusts a pre-resolved absolute path, which lets a host file act", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        filePath: "/tmp/outside/report.md",
        absolutePath: "/tmp/outside/report.md",
      }),
    ).toBe("/tmp/outside/report.md");
  });
});

describe("resolveFileContextMenuRelativePath", () => {
  it("keeps a workspace-relative diff path as is", () => {
    expect(resolveFileContextMenuRelativePath(BASE_TARGET)).toBe("src/index.ts");
  });

  it("strips the repository prefix so the copy matches the file tab, not the diff header", () => {
    expect(
      resolveFileContextMenuRelativePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "packages/app/src/index.ts",
      }),
    ).toBe("src/index.ts");
  });

  it("returns null for a diff path outside the workspace", () => {
    expect(
      resolveFileContextMenuRelativePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "other/src/index.ts",
      }),
    ).toBeNull();
  });

  it("trusts a file surface's path, which is already in workspace form", () => {
    expect(
      resolveFileContextMenuRelativePath({
        ...BASE_TARGET,
        filePath: "docs/README.md",
        absolutePath: "/workspace/project/docs/README.md",
      }),
    ).toBe("docs/README.md");
  });
});

describe("buildFileContextMenuItems", () => {
  it("offers open, reveal, an open-with submenu, then the copy pair when all are available", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      hasRelativePath: true,
      editorIcons: NO_EDITOR_ICONS,
      resolve: m,
      capabilities: {
        revealLabel: "Reveal in Finder",
        canOpenDefault: true,
        editorIds: ["vscode", "cursor", "file-manager"],
      },
    });

    expect(items.map((item) => item.id)).toEqual([
      "open",
      "reveal-in-folder",
      "open-with",
      "copy-relative-path",
      "copy-full-path",
    ]);
    expect(items[0]).toMatchObject({ label: "Open" });
    expect(items[1]).toMatchObject({ label: "Reveal in Finder" });
    const openWith = items[2];
    NodeAssert.ok(openWith);
    expect(openWith.children?.map((child) => child.id)).toEqual(["editor:vscode", "editor:cursor"]);
    // The copy pair is its own section after the launch actions.
    expect(items[3]).toMatchObject({ label: "Copy relative path", separatorBefore: true });
    expect(items[4]).toMatchObject({ label: "Copy full path" });
    expect(items[4]?.separatorBefore).toBeFalsy();
  });

  it("still offers the copy pair, without a leading separator, when nothing can launch", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      hasRelativePath: true,
      capabilities: EMPTY_CAPABILITIES,
      editorIcons: NO_EDITOR_ICONS,
      resolve: m,
    });

    expect(items.map((item) => item.id)).toEqual(["copy-relative-path", "copy-full-path"]);
    expect(items[0]?.separatorBefore).toBeFalsy();
  });

  it("offers only the full path for a host file and keeps the separator on it", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      hasRelativePath: false,
      capabilities: { ...EMPTY_CAPABILITIES, revealLabel: "Reveal in Finder" },
      editorIcons: NO_EDITOR_ICONS,
      resolve: m,
    });

    expect(items.map((item) => item.id)).toEqual(["reveal-in-folder", "copy-full-path"]);
    expect(items[1]).toMatchObject({ separatorBefore: true });
  });
});

describe("revealInFileManagerLabel", () => {
  const serverConfig = {
    shellRevealInFileManager: true,
    availableEditors: ["vscode", "file-manager"],
    environment: { platform: { os: "darwin" } },
  } as unknown as ServerConfig;

  const onHost = {
    environmentId: BASE_TARGET.environmentId,
    remoteOpenMode: "local-exec",
    remoteOpenResolved: true,
  } as const;

  it("uses the host OS wording while the viewer is on the host machine", () => {
    expect(revealInFileManagerLabel({ ...onHost, serverConfig })).toBe("Reveal in Finder");
  });

  it("prefers the server's reveal kind over the host OS", () => {
    expect(
      revealInFileManagerLabel({
        ...onHost,
        serverConfig: { ...serverConfig, shellRevealInFileManagerKind: "file-explorer" },
      }),
    ).toBe("Reveal in File Explorer");
  });

  it.each(["remote-links", "remote-unavailable"] as const)(
    "hides reveal for a remote environment (%s): it would open on another machine",
    (remoteOpenMode) => {
      expect(revealInFileManagerLabel({ ...onHost, serverConfig, remoteOpenMode })).toBeUndefined();
    },
  );

  it("hides reveal until the remote-open state resolves, since the default reads as local", () => {
    expect(
      revealInFileManagerLabel({ ...onHost, serverConfig, remoteOpenResolved: false }),
    ).toBeUndefined();
  });

  it("hides reveal without an environment to run it on", () => {
    expect(
      revealInFileManagerLabel({ ...onHost, serverConfig, environmentId: null }),
    ).toBeUndefined();
  });

  it("hides reveal when the server does not advertise it", () => {
    expect(
      revealInFileManagerLabel({
        ...onHost,
        serverConfig: { ...serverConfig, shellRevealInFileManager: false },
      }),
    ).toBeUndefined();
    expect(revealInFileManagerLabel({ ...onHost, serverConfig: null })).toBeUndefined();
  });
});

describe("useFileContextMenu", () => {
  it.each<[string, RemoteOpenResolution]>([
    ["remote-unavailable", { state: { mode: "remote-unavailable" }, isResolved: true }],
    ["unresolved", { state: { mode: "local-exec" }, isResolved: false }],
  ])("offers no open actions when remote open is %s", async (_mode, resolution) => {
    state.remoteOpen = resolution;
    state.openInEditor.mockClear();
    const menu = useFileContextMenu(BASE_TARGET.environmentId);

    // Copying needs only the path, so it survives without a host to launch on.
    expect(menu.buildItems(BASE_TARGET).map((item) => item.id)).toEqual([
      "copy-relative-path",
      "copy-full-path",
    ]);
    await menu.activate("open", BASE_TARGET);
    await menu.activate("editor:vscode", BASE_TARGET);
    expect(state.openInEditor).not.toHaveBeenCalled();
  });

  it("opens files over SSH remote links instead of on the server host", async () => {
    state.remoteOpen = {
      state: { mode: "remote-links", host: { kind: "ssh-alias", host: "box", username: "me" } },
      isResolved: true,
    };
    state.openInEditor.mockClear();
    state.openRemoteEditorUrl.mockClear();
    const menu = useFileContextMenu(BASE_TARGET.environmentId);

    const items = menu.buildItems(BASE_TARGET);
    expect(items.map((item) => item.id)).toEqual([
      "open-with",
      "copy-relative-path",
      "copy-full-path",
    ]);
    expect(items[0]).toEqual({
      id: "open-with",
      label: "Open with",
      children: [{ id: "editor:vscode", label: "VS Code" }],
    });
    await menu.activate("open", BASE_TARGET);
    await menu.activate("editor:vscode", BASE_TARGET);
    await menu.activate("editor:vscode", { ...BASE_TARGET, filePath: "src", isDirectory: true });
    expect(state.openInEditor).not.toHaveBeenCalled();
    expect(state.openRemoteEditorUrl.mock.calls).toEqual([
      ["vscode://vscode-remote/ssh-remote+me%40box/workspace/project/src/index.ts:1:1"],
      ["vscode://vscode-remote/ssh-remote+me%40box/workspace/project/src?windowId=_blank"],
    ]);
  });

  it("opens files on the server host when remote open is local-exec", async () => {
    state.remoteOpen = { state: { mode: "local-exec" }, isResolved: true };
    state.openInEditor.mockClear();
    const menu = useFileContextMenu(BASE_TARGET.environmentId);

    expect(menu.buildItems(BASE_TARGET).map((item) => item.id)).toEqual([
      "open",
      "reveal-in-folder",
      "open-with",
      "copy-relative-path",
      "copy-full-path",
    ]);
    await menu.activate("open", BASE_TARGET);
    expect(state.openInEditor).toHaveBeenCalledWith({
      environmentId: BASE_TARGET.environmentId,
      input: { cwd: "/workspace/project/src/index.ts", editor: "file-manager" },
    });
  });
});
