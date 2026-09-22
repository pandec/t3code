import { describe, expect, it } from "vite-plus/test";

import { boundedProjectFileRead } from "./t3ProjectFileDefaults";

describe("boundedProjectFileRead", () => {
  it("resolves null when the read never settles (offline environment)", async () => {
    // The file query atom suspends forever while the environment has no
    // connected RPC generation; New Thread must not hang with it.
    const neverSettles = new Promise<never>(() => {});
    await expect(boundedProjectFileRead(neverSettles, 10)).resolves.toBeNull();
  });

  it("resolves the file's mode when the read settles before the deadline", async () => {
    await expect(
      boundedProjectFileRead(Promise.resolve({ defaultThreadEnvMode: "worktree" as const }), 1_000),
    ).resolves.toEqual({ defaultThreadEnvMode: "worktree" });
  });

  it("passes through a null read (missing or invalid file)", async () => {
    await expect(boundedProjectFileRead(Promise.resolve(null), 1_000)).resolves.toBeNull();
  });
});
