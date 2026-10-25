export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
export const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
export const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMinimumWidth(brandWidth: number): number {
  return Math.max(THREAD_SIDEBAR_MIN_WIDTH, Math.ceil(brandWidth));
}

export function resolveThreadSidebarMaximumWidth(
  viewportWidth: number,
  minimumWidth = THREAD_SIDEBAR_MIN_WIDTH,
): number {
  // A flat 40rem main-content reservation leaves almost no travel on a default desktop
  // window (~916px caps the sidebar at 276px). Below ~80rem it scales to half the window;
  // rounding up hands the odd pixel to the main content so the sidebar never exceeds half.
  const reservedMainContentWidth = Math.min(
    THREAD_MAIN_CONTENT_MIN_WIDTH,
    Math.ceil(Math.floor(viewportWidth) / 2),
  );
  return Math.max(minimumWidth, Math.floor(viewportWidth) - reservedMainContentWidth);
}

export function clampThreadSidebarWidth(
  width: number,
  minimumWidth: number,
  maximumWidth: number,
): number {
  return Math.min(maximumWidth, Math.max(minimumWidth, width));
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
  minimumWidth = THREAD_SIDEBAR_MIN_WIDTH,
): number {
  return clampThreadSidebarWidth(
    storedWidth ?? THREAD_SIDEBAR_DEFAULT_WIDTH,
    minimumWidth,
    resolveThreadSidebarMaximumWidth(viewportWidth, minimumWidth),
  );
}
