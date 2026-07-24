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
  instances: [] as Array<{
    readonly options: Electron.NotificationConstructorOptions;
    readonly show: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => void;
  }>,
}));

vi.mock("electron", () => {
  class NotificationMock {
    static isSupported() {
      return electronMocks.supported;
    }

    readonly show = vi.fn();
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
  return {
    window: {
      isDestroyed: vi.fn(() => false),
      once: windowEvents.once,
      removeListener: windowEvents.removeListener,
      webContents: {
        isLoadingMainFrame: vi.fn(() => loading),
        once: webContentsEvents.once,
        removeListener: webContentsEvents.removeListener,
      },
    } as unknown as Electron.BrowserWindow,
    finishLoad: () => webContentsEvents.emit("did-finish-load"),
  };
}

beforeEach(() => {
  electronMocks.supported = true;
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

  it.effect("recreates the main window, waits for its renderer, then delivers the click", () => {
    const { window, finishLoad } = makeWindow(true);
    const order: string[] = [];
    const reveal = vi.fn(() =>
      Effect.sync(() => {
        order.push("reveal");
      }),
    );
    const sendAll = vi.fn(() =>
      Effect.sync(() => {
        order.push("send");
      }),
    );
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
      expect(sendAll).not.toHaveBeenCalled();

      finishLoad();
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(sendAll).toHaveBeenCalledWith(
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
        sendAll,
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.provideService(DesktopWindow.DesktopWindow, {
        ensureMain,
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    );
  });

  it.effect("still delivers the click when revealing the window fails", () => {
    const { window } = makeWindow(false);
    const sendAll = vi.fn(() => Effect.void);
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
          expect(sendAll).toHaveBeenCalledOnce();
        }),
      );
    }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        reveal: () => Effect.die("window race"),
        sendAll,
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.provideService(DesktopWindow.DesktopWindow, {
        ensureMain: Effect.succeed(window),
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    );
  });
});
