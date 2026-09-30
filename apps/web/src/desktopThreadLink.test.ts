import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { type DesktopThreadLinkDependencies, resolveDesktopThreadLink } from "./desktopThreadLink";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");
const activeRef: ScopedThreadRef = {
  environmentId: primaryEnvironmentId,
  threadId: ThreadId.make("thread-active"),
};
const archivedRef: ScopedThreadRef = {
  environmentId: primaryEnvironmentId,
  threadId: ThreadId.make("thread-archived"),
};

function dependencies(
  overrides: Partial<DesktopThreadLinkDependencies> = {},
): DesktopThreadLinkDependencies {
  const same = (left: ScopedThreadRef, right: ScopedThreadRef) =>
    left.environmentId === right.environmentId && left.threadId === right.threadId;
  return {
    isKnownEnvironment: (environmentId) =>
      environmentId === primaryEnvironmentId || environmentId === remoteEnvironmentId,
    primaryEnvironmentId: () => primaryEnvironmentId,
    waitForThreadList: async () => true,
    hasActiveThread: (ref) => same(ref, activeRef),
    hasArchivedThread: async (ref) => same(ref, archivedRef),
    ...overrides,
  };
}

describe("resolveDesktopThreadLink", () => {
  it("opens an active thread without reading the archive", async () => {
    const hasArchivedThread = vi.fn(async () => false);
    await expect(
      resolveDesktopThreadLink(
        { environmentId: primaryEnvironmentId, threadId: activeRef.threadId },
        dependencies({ hasArchivedThread }),
      ),
    ).resolves.toEqual({ kind: "open", threadRef: activeRef });
    expect(hasArchivedThread).not.toHaveBeenCalled();
  });

  it("opens an archived thread", async () => {
    await expect(
      resolveDesktopThreadLink(
        { environmentId: primaryEnvironmentId, threadId: archivedRef.threadId },
        dependencies(),
      ),
    ).resolves.toEqual({ kind: "open", threadRef: archivedRef });
  });

  it("opens a thread that became active while the archive loaded", async () => {
    let active = false;
    await expect(
      resolveDesktopThreadLink(
        { environmentId: primaryEnvironmentId, threadId: archivedRef.threadId },
        dependencies({
          hasActiveThread: () => active,
          hasArchivedThread: async () => {
            active = true;
            return false;
          },
        }),
      ),
    ).resolves.toEqual({ kind: "open", threadRef: archivedRef });
  });

  it("resolves the primary alias to the primary environment", async () => {
    await expect(
      resolveDesktopThreadLink(
        { environmentId: "primary", threadId: activeRef.threadId },
        dependencies(),
      ),
    ).resolves.toEqual({ kind: "open", threadRef: activeRef });
  });

  it("reports an unknown environment or thread", async () => {
    await expect(
      resolveDesktopThreadLink(
        { environmentId: "env-missing", threadId: activeRef.threadId },
        dependencies(),
      ),
    ).resolves.toEqual({ kind: "environment-not-found" });
    await expect(
      resolveDesktopThreadLink(
        { environmentId: "primary", threadId: activeRef.threadId },
        dependencies({ primaryEnvironmentId: () => null }),
      ),
    ).resolves.toEqual({ kind: "environment-not-found" });
    await expect(
      resolveDesktopThreadLink(
        { environmentId: primaryEnvironmentId, threadId: "thread-missing" },
        dependencies(),
      ),
    ).resolves.toEqual({ kind: "thread-not-found" });
  });

  it("reports an environment whose threads or archive cannot load", async () => {
    await expect(
      resolveDesktopThreadLink(
        { environmentId: remoteEnvironmentId, threadId: "thread-1" },
        dependencies({ waitForThreadList: async () => false }),
      ),
    ).resolves.toEqual({ kind: "environment-unavailable" });
    await expect(
      resolveDesktopThreadLink(
        { environmentId: remoteEnvironmentId, threadId: "thread-1" },
        dependencies({ hasArchivedThread: async () => null }),
      ),
    ).resolves.toEqual({ kind: "environment-unavailable" });
  });
});
