import * as Context from "effect/Context";

/**
 * Accepts thread links that surface inside the app rather than from the OS.
 * The preview browser's session cannot hand the app's own scheme to the OS, so
 * a thread link clicked in a previewed page comes here. `receive` returns
 * whether the URL was a thread link for this app; the caller then cancels its
 * own navigation.
 */
export class DesktopThreadLinkReceiver extends Context.Service<
  DesktopThreadLinkReceiver,
  { readonly receive: (url: string) => boolean }
>()("@t3tools/desktop/app/DesktopThreadLinkReceiver") {}
