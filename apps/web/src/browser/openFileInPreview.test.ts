import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { openFileInSystemBrowser } from "./openFileInPreview";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

const open = (input: {
  readonly hostIsLocal: boolean;
  readonly assetFails?: boolean;
  readonly window: object;
}) => {
  vi.stubGlobal("window", input.window);
  const createAssetUrl = vi.fn(async () =>
    input.assetFails
      ? AsyncResult.failure<never, Error>(Cause.fail(new Error("denied")))
      : AsyncResult.success({ relativeUrl: "/api/assets/page.html?token=t", expiresAt: 0 }),
  );
  const result = openFileInSystemBrowser({
    threadRef,
    resolveFilePath: async () => "/work/page.html",
    workspaceRoot: "/work",
    httpBaseUrl: "http://host:3773",
    hostIsLocal: input.hostIsLocal,
    createAssetUrl,
  });
  return { result, createAssetUrl };
};

describe("openFileInSystemBrowser", () => {
  it("opens the file itself on its desktop host and the asset URL elsewhere", async () => {
    try {
      const bridge = {
        openFileInBrowser: vi.fn(async (filePath: string) => filePath === "/work/page.html"),
        openExternal: vi.fn(async () => true),
      };
      const local = open({ hostIsLocal: true, window: { desktopBridge: bridge } });
      expect((await local.result)._tag).toBe("Success");
      expect(local.createAssetUrl).not.toHaveBeenCalled();

      const remote = open({ hostIsLocal: false, window: { desktopBridge: bridge } });
      expect((await remote.result)._tag).toBe("Success");
      expect(bridge.openFileInBrowser).toHaveBeenCalledTimes(1);
      expect(bridge.openExternal).toHaveBeenCalledWith(
        "http://host:3773/api/assets/page.html?token=t",
      );

      // The desktop has no such file, e.g. a WSL backend's path.
      bridge.openFileInBrowser.mockResolvedValueOnce(false);
      const missing = open({ hostIsLocal: true, window: { desktopBridge: bridge } });
      expect((await missing.result)._tag).toBe("Success");
      expect(bridge.openExternal).toHaveBeenCalledTimes(2);

      bridge.openFileInBrowser.mockRejectedValueOnce(new Error("IPC failed"));
      const rejected = open({ hostIsLocal: true, window: { desktopBridge: bridge } });
      expect((await rejected.result)._tag).toBe("Failure");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("navigates the tab the web click opened, and closes it when the URL fails", async () => {
    try {
      const tab = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
      const windowOpen = vi.fn(() => tab);
      const opened = open({ hostIsLocal: true, window: { open: windowOpen } });
      expect(windowOpen).toHaveBeenCalledTimes(1);
      expect((await opened.result)._tag).toBe("Success");
      expect(tab.opener).toBeNull();
      expect(tab.location.replace).toHaveBeenCalledWith(
        "http://host:3773/api/assets/page.html?token=t",
      );

      const failed = open({ hostIsLocal: true, assetFails: true, window: { open: windowOpen } });
      expect((await failed.result)._tag).toBe("Failure");
      expect(tab.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
