import { EnvironmentId, ThreadId, type DesktopBridge } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installWindow(overrides: Record<string, unknown> = {}) {
  const focus = vi.fn();
  vi.stubGlobal("window", {
    isSecureContext: true,
    focus,
    ...overrides,
  });
  return { focus };
}

describe("browser turn completion notifications", () => {
  it("suppresses system notifications only while the document is visible and focused", async () => {
    const { shouldShowTurnCompletionSystemNotification } = await import("./turnCompletion");

    expect(
      shouldShowTurnCompletionSystemNotification({
        enabled: true,
        visibilityState: "visible",
        hasFocus: true,
      }),
    ).toBe(false);
    expect(
      shouldShowTurnCompletionSystemNotification({
        enabled: true,
        visibilityState: "visible",
        hasFocus: false,
      }),
    ).toBe(true);
    expect(
      shouldShowTurnCompletionSystemNotification({
        enabled: true,
        visibilityState: "hidden",
        hasFocus: true,
      }),
    ).toBe(true);
    expect(
      shouldShowTurnCompletionSystemNotification({
        enabled: false,
        visibilityState: "hidden",
        hasFocus: false,
      }),
    ).toBe(false);
  });

  it("degrades when the Notification API is undefined", async () => {
    installWindow();
    vi.stubGlobal("Notification", undefined);
    const { readBrowserNotificationPermissionState, showSystemNotification } =
      await import("./turnCompletion");

    expect(readBrowserNotificationPermissionState()).toBe("unsupported");
    await expect(showSystemNotification({ title: "Done", body: "Thread" })).resolves.toBe(false);
  });

  it.each(["denied", "default"] as const)(
    "preserves a dismissed or denied permission result: %s",
    async (result) => {
      installWindow();
      const requestPermission = vi.fn().mockResolvedValue(result);
      vi.stubGlobal("Notification", {
        permission: "default",
        requestPermission,
      });
      const { requestBrowserNotificationPermission } = await import("./turnCompletion");

      await expect(requestBrowserNotificationPermission()).resolves.toBe(result);
      expect(requestPermission).toHaveBeenCalledOnce();
    },
  );

  it("contains desktop bridge rejection", async () => {
    const show = vi.fn().mockRejectedValue(new Error("native notification failed"));
    installWindow({
      desktopBridge: {
        notifications: {
          show,
          onNotificationClicked: vi.fn(),
        },
      } as unknown as DesktopBridge,
    });
    const { showSystemNotification } = await import("./turnCompletion");

    await expect(showSystemNotification({ title: "Done", body: "Thread" })).resolves.toBe(false);
  });

  it("constructs the browser notification and routes its click", async () => {
    let clickListener: (() => void) | undefined;
    const onBrowserNotificationClick = vi.fn();
    const notification = {
      addEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "click") {
          clickListener = listener;
        }
      }),
    };
    const constructNotification = vi.fn();
    class NotificationMock {
      static permission = "granted";
      static requestPermission = vi.fn();

      constructor(title: string, options: NotificationOptions) {
        constructNotification(title, options);
        return notification;
      }
    }
    const { focus } = installWindow();
    vi.stubGlobal("Notification", NotificationMock);
    const { showSystemNotification } = await import("./turnCompletion");

    await expect(
      showSystemNotification({
        title: "Done",
        body: "Thread",
        threadRef: {
          environmentId: EnvironmentId.make("env-1"),
          threadId: ThreadId.make("thread-1"),
        },
        onBrowserNotificationClick,
      }),
    ).resolves.toBe(true);
    expect(constructNotification).toHaveBeenCalledWith("Done", {
      body: "Thread",
      tag: "turn-completed:env-1:thread-1",
    });

    clickListener?.();
    expect(focus).toHaveBeenCalledOnce();
    expect(onBrowserNotificationClick).toHaveBeenCalledOnce();
  });
});
