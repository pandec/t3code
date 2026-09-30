import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopThreadLinks from "../../app/DesktopThreadLinks.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_THREAD_LINK_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.threadLinks.setReady")(function* (ready) {
    const threadLinks = yield* DesktopThreadLinks.DesktopThreadLinks;
    yield* threadLinks.setRendererReady(ready);
  }),
});
