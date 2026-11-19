import { describe, expect, it } from "vite-plus/test";

import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarMinimumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_DEFAULT_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
} from "./threadSidebarWidth";

function renderedWidth(
  sidebarWidth: number,
  viewportWidth: number,
  minimumWidth = resolveThreadSidebarMinimumWidth(0),
): number {
  return clampThreadSidebarWidth(
    sidebarWidth,
    minimumWidth,
    resolveThreadSidebarMaximumWidth(viewportWidth, minimumWidth),
  );
}

describe("thread sidebar width", () => {
  it("uses the default width when no preference is stored", () => {
    expect(resolveInitialThreadSidebarWidth(null)).toBe(THREAD_SIDEBAR_DEFAULT_WIDTH);
  });

  it("clamps a stored width to the sidebar minimum", () => {
    expect(resolveInitialThreadSidebarWidth(120)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("restores the stored width when the viewport widens after a narrow startup", () => {
    const sidebarWidth = resolveInitialThreadSidebarWidth(350);
    expect(renderedWidth(sidebarWidth, 400)).toBe(208);
    expect(renderedWidth(sidebarWidth, 1638)).toBe(350);
  });

  it("restores the default width when the viewport widens after a narrow startup", () => {
    const sidebarWidth = resolveInitialThreadSidebarWidth(null);
    expect(renderedWidth(sidebarWidth, 400)).toBe(208);
    expect(renderedWidth(sidebarWidth, 1638)).toBe(256);
  });

  it("leaves enough room for the main content on a wide window", () => {
    expect(renderedWidth(1500, 1600)).toBe(1600 - THREAD_MAIN_CONTENT_MIN_WIDTH);
  });

  it("still gives the sidebar room to grow on a default-sized desktop window", () => {
    // A flat 40rem reservation would cap this at 276px, which is where the
    // sidebar already sits by default — the rail would have nowhere to go.
    expect(resolveThreadSidebarMaximumWidth(916)).toBe(458);
  });

  it("never lets the sidebar take more than half of a narrow window", () => {
    expect(renderedWidth(900, 1000)).toBe(500);
    expect(resolveThreadSidebarMaximumWidth(917)).toBe(458);
  });

  it("switches over to the flat main content reservation at 80rem", () => {
    expect(resolveThreadSidebarMaximumWidth(1280)).toBe(1280 - THREAD_MAIN_CONTENT_MIN_WIDTH);
    expect(resolveThreadSidebarMaximumWidth(1279)).toBe(639);
  });

  it("keeps a raised minimum on narrow viewports", () => {
    expect(renderedWidth(900, 300)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
    expect(resolveThreadSidebarMaximumWidth(400, 238)).toBe(238);
    expect(resolveThreadSidebarMaximumWidth(1600, 238)).toBe(960);
    expect(renderedWidth(208, 1200, 238)).toBe(238);
    expect(renderedWidth(THREAD_SIDEBAR_DEFAULT_WIDTH, 400, 300)).toBe(300);
  });
});
