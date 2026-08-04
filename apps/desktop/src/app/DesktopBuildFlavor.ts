declare const __T3CODE_BUILD_DESKTOP_FLAVOR__: string | undefined;

export type DesktopBuildFlavor = "release" | "dev";

/** Build-time flavor injected by `apps/desktop/vite.config.ts`. */
export const desktopBuildFlavor: DesktopBuildFlavor =
  typeof __T3CODE_BUILD_DESKTOP_FLAVOR__ !== "undefined" &&
  __T3CODE_BUILD_DESKTOP_FLAVOR__ === "dev"
    ? "dev"
    : "release";

/**
 * A packaged Dev build carries the development identity (scheme, WM class, state dir)
 * without running against a Vite dev server, so it cannot be detected from the environment.
 * Safe to read before Electron emits `ready`.
 */
export function isPackagedDevBuild(isPackaged: boolean): boolean {
  return isPackaged && desktopBuildFlavor === "dev";
}
