import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as NodeAssert from "node:assert/strict";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFileContextMenuItems,
  resolveFileContextMenuAbsolutePath,
  revealInFileManagerLabel,
} from "./fileContextMenu";

const BASE_TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};

const EMPTY_CAPABILITIES = {
  revealLabel: undefined,
  canOpenDefault: false,
  editorIds: [],
};

describe("resolveFileContextMenuAbsolutePath", () => {
  it("joins workspace-relative diff paths onto the workspace root", () => {
    expect(resolveFileContextMenuAbsolutePath(BASE_TARGET)).toBe("/workspace/project/src/index.ts");
  });

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

describe("buildFileContextMenuItems", () => {
  it("offers open, reveal, an open-with submenu, then the copy pair when all are available", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      hasRelativePath: true,
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

  it("offers reveal and the copy pair when just reveal is enabled", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      hasRelativePath: true,
      capabilities: {
        revealLabel: "Reveal in File Explorer",
        canOpenDefault: false,
        editorIds: [],
      },
    });

    expect(items.map((item) => item.id)).toEqual([
      "reveal-in-folder",
      "copy-relative-path",
      "copy-full-path",
    ]);
    expect(items[0]).toMatchObject({ label: "Reveal in File Explorer" });
  });

  it("still offers the copy pair, without a leading separator, when nothing can launch", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      hasRelativePath: true,
      capabilities: EMPTY_CAPABILITIES,
    });

    expect(items.map((item) => item.id)).toEqual(["copy-relative-path", "copy-full-path"]);
    expect(items[0]?.separatorBefore).toBeFalsy();
  });

  it("offers only the full path for a host file and keeps the separator on it", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      hasRelativePath: false,
      capabilities: { ...EMPTY_CAPABILITIES, revealLabel: "Reveal in Finder" },
    });

    expect(items.map((item) => item.id)).toEqual(["reveal-in-folder", "copy-full-path"]);
    expect(items[1]).toMatchObject({ separatorBefore: true });
  });

  it("offers nothing when the path cannot be resolved", () => {
    expect(
      buildFileContextMenuItems({
        hasAbsolutePath: false,
        hasRelativePath: true,
        capabilities: {
          revealLabel: "Reveal in Finder",
          canOpenDefault: true,
          editorIds: ["vscode"],
        },
      }),
    ).toEqual([]);
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
