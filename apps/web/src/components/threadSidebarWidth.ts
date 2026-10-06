export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
export const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
export const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

// The brand's measured width can raise the minimum so "T3 Code" never clips.
export function resolveThreadSidebarMinimumWidth(brandWidth: number): number {
  return Math.max(THREAD_SIDEBAR_MIN_WIDTH, Math.ceil(brandWidth));
}

export function resolveThreadSidebarMaximumWidth(
  viewportWidth: number,
  minimumWidth = THREAD_SIDEBAR_MIN_WIDTH,
): number {
  // Reserving a flat 40rem for the main content leaves almost no travel on a
  // default-sized desktop window (~916px inner width caps the sidebar at 276px,
  // where it usually already sits), so the rail feels dead. Below ~80rem the
  // reservation scales down to half the window instead: the main content still
  // keeps at least half, and the sidebar always has room to grow.
  // Rounding up hands the odd pixel to the main content, so the sidebar stays
  // at or below half the window rather than one pixel past it.
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
