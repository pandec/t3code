import { DesktopNotificationShowInputSchema } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const MAX_RETAINED_NOTIFICATIONS = 100;
const NOTIFICATION_SHOW_TIMEOUT_MS = 5_000;
const activeNotifications = new Set<Electron.Notification>();

function closeNotificationBestEffort(notification: Electron.Notification): void {
  try {
    notification.close();
  } catch {
    // Retention is a best-effort safety net; notification cleanup must not
    // make another platform operation fail.
  }
}

function retainNotification(notification: Electron.Notification): () => void {
  activeNotifications.add(notification);
  if (activeNotifications.size > MAX_RETAINED_NOTIFICATIONS) {
    const oldest = activeNotifications.values().next().value;
    if (oldest !== undefined) {
      activeNotifications.delete(oldest);
      // Do not leave an Action Center entry visible after dropping the
      // instance that owns its click listener.
      closeNotificationBestEffort(oldest);
    }
  }
  return () => {
    activeNotifications.delete(notification);
  };
}

function waitForRendererLoad(window: Electron.BrowserWindow): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (window.isDestroyed() || !window.webContents.isLoadingMainFrame()) {
      resume(Effect.void);
      return;
    }

    const finish = () => {
      window.webContents.removeListener("did-finish-load", finish);
      window.removeListener("closed", finish);
      resume(Effect.void);
    };
    window.webContents.once("did-finish-load", finish);
    window.once("closed", finish);
    return Effect.sync(() => {
      window.webContents.removeListener("did-finish-load", finish);
      window.removeListener("closed", finish);
    });
  });
}

export const showNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.NOTIFICATIONS_SHOW_CHANNEL,
  payload: DesktopNotificationShowInputSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.notifications.show")(function* (input) {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    // The click callback fires long after this handler's Effect has finished,
    // so it re-enters the runtime with the captured services.
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);

    const title = input.title.trim();
    if (title.length === 0 || !Electron.Notification.isSupported()) {
      return false;
    }

    const notification = new Electron.Notification({
      title,
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    const releaseNotification = retainNotification(notification);
    notification.once("close", (event) => {
      // Windows emits close when the initial popup times out even though the
      // same actionable entry can remain in Action Center.
      if (event.reason !== "timedOut") {
        releaseNotification();
      }
    });

    const threadRef = input.threadRef;
    notification.on("click", () => {
      releaseNotification();
      void runPromise(
        Effect.gen(function* () {
          const window = yield* desktopWindow.ensureMain;
          yield* electronWindow.reveal(window).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not reveal the window after a notification click.", {
                cause: Cause.pretty(cause),
              }),
            ),
          );
          if (threadRef !== undefined) {
            yield* waitForRendererLoad(window);
            if (window.isDestroyed()) {
              return;
            }
            yield* Effect.sync(() => {
              window.webContents.send(IpcChannels.NOTIFICATION_CLICKED_CHANNEL, threadRef);
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not handle a desktop notification click.", {
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.withSpan("desktop.ipc.notifications.click"),
        ),
      );
    });

    const shown = yield* Effect.callback<boolean>((resume) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        notification.removeListener("show", onShow);
        notification.removeListener("failed", onFailed);
        if (!result) {
          releaseNotification();
        }
        resume(Effect.succeed(result));
      };
      const onShow = () => {
        finish(true);
      };
      const onFailed = () => {
        finish(false);
      };

      notification.once("show", onShow);
      notification.once("failed", onFailed);
      try {
        notification.show();
      } catch {
        finish(false);
      }

      return Effect.sync(() => {
        notification.removeListener("show", onShow);
        notification.removeListener("failed", onFailed);
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: NOTIFICATION_SHOW_TIMEOUT_MS,
        orElse: () =>
          Effect.sync(() => {
            releaseNotification();
            closeNotificationBestEffort(notification);
            return false;
          }),
      }),
    );
    return shown;
  }),
});
