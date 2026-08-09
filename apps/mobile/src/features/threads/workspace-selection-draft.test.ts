import { describe, expect, it } from "vite-plus/test";

import { workspaceMetadataSelection } from "./workspace-selection-draft";

describe("workspace metadata selection", () => {
  // The provisional default (project setting → t3.json → global) must never
  // reach the draft through a metadata control: t3.json can still land and
  // change it, and the frozen interim value would win.
  it("omits the mode when the user has not picked one", () => {
    const selection = workspaceMetadataSelection({
      explicitMode: undefined,
      branch: "main",
      worktreePath: null,
      startFromOrigin: true,
    });

    expect(selection.mode).toBeUndefined();
    expect("mode" in selection).toBe(false);
    expect(selection).toEqual({ branch: "main", worktreePath: null, startFromOrigin: true });
  });

  it("keeps a mode the user explicitly picked", () => {
    expect(
      workspaceMetadataSelection({
        explicitMode: "worktree",
        branch: "feature",
        worktreePath: "/tmp/wt",
        startFromOrigin: false,
      }),
    ).toEqual({
      mode: "worktree",
      branch: "feature",
      worktreePath: "/tmp/wt",
      startFromOrigin: false,
    });
  });

  // startFromOrigin has the same resolved-vs-explicit split as the mode: an
  // unset flag keeps following the server's newWorktreesStartFromOrigin.
  it("omits start-from-origin until it is explicitly set", () => {
    const selection = workspaceMetadataSelection({
      explicitMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: undefined,
    });

    expect("startFromOrigin" in selection).toBe(false);
    expect(selection).toEqual({ mode: "local", branch: null, worktreePath: null });
  });
});
