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
const activeNotifications = new Set<Electron.Notification>();

function retainNotification(notification: Electron.Notification): () => void {
  activeNotifications.add(notification);
  if (activeNotifications.size > MAX_RETAINED_NOTIFICATIONS) {
    const oldest = activeNotifications.values().next().value;
    if (oldest !== undefined) {
      activeNotifications.delete(oldest);
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
    notification.once("close", releaseNotification);
    notification.once("failed", releaseNotification);

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
            yield* electronWindow.sendAll(IpcChannels.NOTIFICATION_CLICKED_CHANNEL, threadRef);
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

    const shown = yield* Effect.try({
      try: () => {
        notification.show();
        return true;
      },
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false));
    if (!shown) {
      releaseNotification();
    }
    return shown;
  }),
});
