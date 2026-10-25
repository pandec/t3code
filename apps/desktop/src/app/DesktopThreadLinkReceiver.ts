import * as Context from "effect/Context";

/**
 * Accepts thread links clicked inside previewed pages: the preview browser's session cannot hand
 * the app's own scheme to the OS. `receive` returns whether the URL was a thread link for this
 * app; the caller then cancels its own navigation.
 */
export class DesktopThreadLinkReceiver extends Context.Service<
  DesktopThreadLinkReceiver,
  { readonly receive: (url: string) => boolean }
>()("@t3tools/desktop/app/DesktopThreadLinkReceiver") {}
