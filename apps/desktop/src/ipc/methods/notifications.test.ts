import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, expect, vi } from "vite-plus/test";

import type * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import { showNotification } from "./notifications.ts";

const electronMocks = vi.hoisted(() => ({
  supported: true,
  showResult: "show" as "show" | "failed" | "throw",
  instances: [] as Array<{
    readonly options: Electron.NotificationConstructorOptions;
    readonly show: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => void;
  }>,
}));

vi.mock("electron", () => {
  class NotificationMock {
    static isSupported() {
      return electronMocks.supported;
    }

    readonly show = vi.fn(() => {
      if (electronMocks.showResult === "throw") {
        throw new Error("show failed synchronously");
      }
      if (electronMocks.showResult === "failed") {
        this.emit("failed", {}, "native show failed");
        return;
      }
      this.emit("show", {});
    });
    readonly close = vi.fn(() => {
      this.emit("close", { reason: "applicationHidden" });
    });
    readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    readonly options: Electron.NotificationConstructorOptions;

    constructor(options: Electron.NotificationConstructorOptions) {
      this.options = options;
      electronMocks.instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        this.listeners.get(event)?.delete(wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    removeListener(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }
  }

  return { Notification: NotificationMock };
});

function eventSource() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    once: vi.fn((event: string, listener: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      const wrapped = () => {
        eventListeners.delete(wrapped);
        listener();
      };
      eventListeners.add(wrapped);
      listeners.set(event, eventListeners);
    }),
    removeListener: vi.fn((event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener);
    }),
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
}

function makeWindow(loading: boolean) {
  const windowEvents = eventSource();
  const webContentsEvents = eventSource();
  const send = vi.fn();
  return {
    window: {
      isDestroyed: vi.fn(() => false),
      once: windowEvents.once,
      removeListener: windowEvents.removeListener,
      webContents: {
        isLoadingMainFrame: vi.fn(() => loading),
        once: webContentsEvents.once,
        removeListener: webContentsEvents.removeListener,
        send,
      },
    } as unknown as Electron.BrowserWindow,
    finishLoad: () => webContentsEvents.emit("did-finish-load"),
    send,
  };
}

beforeEach(() => {
  for (const notification of electronMocks.instances) {
    notification.emit("close", { reason: "applicationHidden" });
  }
  electronMocks.supported = true;
  electronMocks.showResult = "show";
  electronMocks.instances.length = 0;
});

describe("showNotification", () => {
  it.effect("shows and retains a supported native notification", () => {
    const { window } = makeWindow(false);
    return Effect.gen(function* () {
      const shown = yield* showNotification.handler({
        title: "  Agent finished  ",
        body: "Thread title",
      });

      assert.isTrue(shown);
      expect(electronMocks.instances).toHaveLength(1);
      expect(electronMocks.instances[0]?.options).toEqual({
        title: "Agent finished",
        body: "Thread title",
      });
      expect(electronMocks.instances[0]?.show).toHaveBeenCalledOnce();
    }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        reveal: () => Effect.void,
        sendAll: () => Effect.void,
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.provideService(DesktopWindow.DesktopWindow, {
        ensureMain: Effect.succeed(window),
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    );
  });

  it.effect("reports asynchronous native show failure", () => {
    electronMocks.showResult = "failed";
    const { window } = makeWindow(false);
    return Effect.gen(function* () {
      const shown = yield* showNotification.handler({ title: "Agent finished" });

      assert.isFalse(shown);
      expect(electronMocks.instances[0]?.show).toHaveBeenCalledOnce();
    }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        reveal: () => Effect.void,
        sendAll: () => Effect.void,
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.provideService(DesktopWindow.DesktopWindow, {
        ensureMain: Effect.succeed(window),
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    );
  });

  it.effect("reports a synchronous native show failure", () => {
    electronMocks.showResult = "throw";
    const { window } = makeWindow(false);
    return Effect.gen(function* () {
      const shown = yield* showNotification.handler({ title: "Agent finished" });

      assert.isFalse(shown);
    }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        reveal: () => Effect.void,
        sendAll: () => Effect.void,
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.provideService(DesktopWindow.DesktopWindow, {
        ensureMain: Effect.succeed(window),
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    );
  });

  it.effect("recreates the main window, waits for its renderer, then delivers the click", () => {
    const { window, finishLoad, send } = makeWindow(true);
    const order: string[] = [];
    const reveal = vi.fn(() =>
      Effect.sync(() => {
        order.push("reveal");
      }),
    );
    send.mockImplementation(() => {
      order.push("send");
    });
    const ensureMain = Effect.sync(() => {
      order.push("ensure");
      return window;
    });
    return Effect.gen(function* () {
      yield* showNotification.handler({
        title: "Agent finished",
        threadRef: {
          environmentId: "env-1",
          threadId: "thread-1",
        },
      });

      electronMocks.instances[0]?.emit("click");
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(reveal).toHaveBeenCalledOnce();
        }),
      );
      expect(send).not.toHaveBeenCalled();

      finishLoad();
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(send).toHaveBeenCalledWith(
            IpcChannels.NOTIFICATION_CLICKED_CHANNEL,
            expect.objectContaining({
              environmentId: "env-1",
              threadId: "thread-1",
            }),
          );
        }),
      );
      expect(order).toEqual(["ensure", "reveal", "send"]);
    }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        reveal,
        sendAll: () => Effect.void,
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.provideService(DesktopWindow.DesktopWindow, {
        ensureMain,
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    );
  });

  it.effect("still delivers the click when revealing the window fails", () => {
    const { window, send } = makeWindow(false);
    return Effect.gen(function* () {
      yield* showNotification.handler({
        title: "Agent finished",
        threadRef: {
          environmentId: "env-1",
          threadId: "thread-1",
        },
      });

      electronMocks.instances[0]?.emit("click");
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(send).toHaveBeenCalledOnce();
        }),
      );
    }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        reveal: () => Effect.die("window race"),
        sendAll: () => Effect.void,
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.provideService(DesktopWindow.DesktopWindow, {
        ensureMain: Effect.succeed(window),
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    );
  });

  it.effect("keeps timed-out Action Center entries actionable until bounded eviction", () => {
    const { window } = makeWindow(false);
    return Effect.gen(function* () {
      yield* showNotification.handler({ title: "First" });
      const first = electronMocks.instances[0];
      first?.emit("close", { reason: "timedOut" });

      yield* Effect.forEach(
        Array.from({ length: 100 }),
        (_, index) => showNotification.handler({ title: `Later ${index}` }),
        { discard: true },
      );

      expect(first?.close).toHaveBeenCalledOnce();
    }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        reveal: () => Effect.void,
        sendAll: () => Effect.void,
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.provideService(DesktopWindow.DesktopWindow, {
        ensureMain: Effect.succeed(window),
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    );
  });

  it.effect("releases manually closed notifications from bounded retention", () => {
    const { window } = makeWindow(false);
    return Effect.gen(function* () {
      yield* showNotification.handler({ title: "First" });
      const first = electronMocks.instances[0];
      first?.emit("close", { reason: "userCanceled" });

      yield* Effect.forEach(
        Array.from({ length: 100 }),
        (_, index) => showNotification.handler({ title: `Later ${index}` }),
        { discard: true },
      );

      expect(first?.close).not.toHaveBeenCalled();
    }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        reveal: () => Effect.void,
        sendAll: () => Effect.void,
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.provideService(DesktopWindow.DesktopWindow, {
        ensureMain: Effect.succeed(window),
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    );
  });
});
