import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { providerThreadEnvironment } from "./ProviderThreadEnvironment.ts";

describe("provider thread environment", () => {
  it("isolates sessions, preserves instance settings, and drops inherited turn identity", () => {
    const base = {
      CODEX_HOME: "/account",
      T3CODE_THREAD_ID: "parent",
      T3CODE_TURN_ID: "stale",
      T3CODE_WORKTREE_PATH: "/parent",
    };
    const first = providerThreadEnvironment({ threadId: ThreadId.make("one"), cwd: "/one" }, base, {
      baseDir: "/t3",
      stateDir: "/t3/dev",
    });
    const second = providerThreadEnvironment({ threadId: ThreadId.make("two"), cwd: "/two" }, base);
    expect(first).toEqual({
      T3CODE_HOME: "/t3",
      T3CODE_STATE_DIR: "/t3/dev",
      CODEX_HOME: "/account",
      T3CODE_THREAD_ID: "one",
      T3CODE_WORKTREE_PATH: "/one",
    });
    expect(second.T3CODE_THREAD_ID).toBe("two");
    expect(base.T3CODE_TURN_ID).toBe("stale");
    expect(
      providerThreadEnvironment({ threadId: ThreadId.make("three") }, base).T3CODE_WORKTREE_PATH,
    ).toBeUndefined();
  });
});
