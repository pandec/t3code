import { DesktopNotificationShowInputSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const showNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.NOTIFICATIONS_SHOW_CHANNEL,
  payload: DesktopNotificationShowInputSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.notifications.show")(function* (input) {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
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

    const threadRef = input.threadRef;
    notification.on("click", () => {
      void runPromise(
        Effect.gen(function* () {
          const window = yield* electronWindow.currentMainOrFirst;
          if (Option.isSome(window)) {
            yield* electronWindow.reveal(window.value);
          }
          if (threadRef !== undefined) {
            yield* electronWindow.sendAll(IpcChannels.NOTIFICATION_CLICKED_CHANNEL, threadRef);
          }
        }).pipe(Effect.withSpan("desktop.ipc.notifications.click")),
      );
    });

    notification.show();
    return true;
  }),
});
