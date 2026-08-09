import { describe, expect, it } from "vite-plus/test";

import { inheritedEnvModeLabels } from "./projectEnvModeInheritance";

describe("inheritedEnvModeLabels", () => {
  it("stays neutral while the t3.json query is loading", () => {
    expect(
      inheritedEnvModeLabels({
        status: "loading",
        fileEnvMode: undefined,
        globalEnvMode: "worktree",
      }),
    ).toEqual({ trigger: "Default", inheritItem: "Default" });
  });

  it("names t3.json once a file value is settled", () => {
    expect(
      inheritedEnvModeLabels({
        status: "valid",
        fileEnvMode: "local",
        globalEnvMode: "worktree",
      }),
    ).toEqual({
      trigger: "Default (current checkout)",
      inheritItem: "Default (t3.json: current checkout)",
    });
  });

  it("falls back to the global setting when the file has no value", () => {
    expect(
      inheritedEnvModeLabels({
        status: "missing",
        fileEnvMode: undefined,
        globalEnvMode: "worktree",
      }),
    ).toEqual({
      trigger: "Default (new worktree)",
      inheritItem: "Default (global: new worktree)",
    });
  });

  it("treats an invalid file as the global default", () => {
    expect(
      inheritedEnvModeLabels({
        status: "invalid",
        fileEnvMode: null,
        globalEnvMode: "local",
      }),
    ).toEqual({
      trigger: "Default (current checkout)",
      inheritItem: "Default (global: current checkout)",
    });
  });
});
