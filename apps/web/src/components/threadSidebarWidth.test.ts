import { describe, expect, it } from "vite-plus/test";

import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_DEFAULT_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
} from "./threadSidebarWidth";

describe("thread sidebar width", () => {
  it("uses the default width when no preference is stored", () => {
    expect(resolveInitialThreadSidebarWidth(null, 1200)).toBe(THREAD_SIDEBAR_DEFAULT_WIDTH);
  });

  it("clamps a stored width to the sidebar minimum", () => {
    expect(resolveInitialThreadSidebarWidth(120, 1200)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("leaves enough room for the main content on a wide window", () => {
    expect(resolveInitialThreadSidebarWidth(1500, 1600)).toBe(1600 - THREAD_MAIN_CONTENT_MIN_WIDTH);
  });

  it("still gives the sidebar room to grow on a default-sized desktop window", () => {
    // A flat 40rem reservation would cap this at 276px, which is where the
    // sidebar already sits by default — the rail would have nowhere to go.
    expect(resolveThreadSidebarMaximumWidth(916)).toBe(458);
  });

  it("never lets the sidebar take more than half of a narrow window", () => {
    expect(resolveInitialThreadSidebarWidth(900, 1000)).toBe(500);
    expect(resolveThreadSidebarMaximumWidth(917)).toBe(458);
  });

  it("switches over to the flat main content reservation at 80rem", () => {
    expect(resolveThreadSidebarMaximumWidth(1280)).toBe(1280 - THREAD_MAIN_CONTENT_MIN_WIDTH);
    expect(resolveThreadSidebarMaximumWidth(1279)).toBe(639);
  });

  it("keeps a raised minimum on narrow viewports and for the initial width", () => {
    expect(resolveInitialThreadSidebarWidth(900, 300)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
    expect(resolveThreadSidebarMaximumWidth(400, 238)).toBe(238);
    expect(resolveThreadSidebarMaximumWidth(1600, 238)).toBe(960);
    expect(resolveInitialThreadSidebarWidth(208, 1200, 238)).toBe(238);
    expect(resolveInitialThreadSidebarWidth(null, 400, 300)).toBe(300);
  });
});
