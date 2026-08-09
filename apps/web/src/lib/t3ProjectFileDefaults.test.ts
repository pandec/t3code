import { describe, expect, it } from "vite-plus/test";

import { boundedDefaultThreadEnvModeRead } from "./t3ProjectFileDefaults";

describe("boundedDefaultThreadEnvModeRead", () => {
  it("resolves null when the read never settles (offline environment)", async () => {
    // The file query atom suspends forever while the environment has no
    // connected RPC generation; New Thread must not hang with it.
    const neverSettles = new Promise<never>(() => {});
    await expect(boundedDefaultThreadEnvModeRead(neverSettles, 10)).resolves.toBeNull();
  });

  it("resolves the file's mode when the read settles before the deadline", async () => {
    await expect(
      boundedDefaultThreadEnvModeRead(Promise.resolve("worktree" as const), 1_000),
    ).resolves.toBe("worktree");
  });

  it("passes through a null read (missing or invalid file)", async () => {
    await expect(boundedDefaultThreadEnvModeRead(Promise.resolve(null), 1_000)).resolves.toBeNull();
  });
});
