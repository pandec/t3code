// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares the sidebar component with its width contract.
import * as NodeFS from "node:fs";

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

describe("thread sidebar width", () => {
  it("uses the default width when no preference is stored", () => {
    expect(resolveInitialThreadSidebarWidth(null, 1200)).toBe(THREAD_SIDEBAR_DEFAULT_WIDTH);
  });

  it("uses a stored width in the initial render", () => {
    expect(resolveInitialThreadSidebarWidth(360, 1200)).toBe(360);
  });

  it("clamps a stored width to the sidebar minimum", () => {
    expect(resolveInitialThreadSidebarWidth(120, 1200)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("leaves enough room for the main content on a wide window", () => {
    const viewportWidth = 1600;

    expect(resolveInitialThreadSidebarWidth(1500, viewportWidth)).toBe(
      viewportWidth - THREAD_MAIN_CONTENT_MIN_WIDTH,
    );
  });

  it("still gives the sidebar room to grow on a default-sized desktop window", () => {
    // A flat 40rem reservation would cap this at 276px, which is where the
    // sidebar already sits by default — the rail would have nowhere to go.
    expect(resolveThreadSidebarMaximumWidth(916)).toBe(458);
  });

  it("never lets the sidebar take more than half of a narrow window", () => {
    const viewportWidth = 1000;

    expect(resolveInitialThreadSidebarWidth(900, viewportWidth)).toBe(viewportWidth / 2);
  });

  it("gives the odd pixel of a narrow window to the main content", () => {
    expect(resolveThreadSidebarMaximumWidth(917)).toBe(458);
  });

  it("switches over to the flat main content reservation at 80rem", () => {
    expect(resolveThreadSidebarMaximumWidth(1280)).toBe(1280 - THREAD_MAIN_CONTENT_MIN_WIDTH);
    expect(resolveThreadSidebarMaximumWidth(1279)).toBe(639);
  });

  it("keeps the sidebar minimum when the whole layout is narrower than its minimums", () => {
    expect(resolveInitialThreadSidebarWidth(900, 300)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("shows the desktop wordmark across the sidebar's full legal width range", () => {
    const sidebarSource = NodeFS.readFileSync(
      new URL("./sidebar/SidebarChrome.tsx", import.meta.url),
      "utf8",
    );

    expect(sidebarSource).toContain(
      "hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden",
    );
    expect(sidebarSource).toContain("md:flex");
    expect(THREAD_SIDEBAR_MIN_WIDTH).toBe(13 * 16);
  });
});

describe("resolveThreadSidebarMinimumWidth", () => {
  it("keeps the default minimum when the brand fits", () => {
    expect(resolveThreadSidebarMinimumWidth(0)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
    expect(resolveThreadSidebarMinimumWidth(194)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("grows to a brand wider than the default, rounding up", () => {
    expect(resolveThreadSidebarMinimumWidth(237.2)).toBe(238);
  });
});

describe("resolveThreadSidebarMaximumWidth", () => {
  it("never drops below a raised minimum on a narrow viewport", () => {
    expect(resolveThreadSidebarMaximumWidth(400, 238)).toBe(238);
    expect(resolveThreadSidebarMaximumWidth(1200, 238)).toBe(600);
    expect(resolveThreadSidebarMaximumWidth(1600, 238)).toBe(960);
  });

  it("keeps a raised minimum for the initial width", () => {
    expect(resolveInitialThreadSidebarWidth(208, 1200, 238)).toBe(238);
    expect(resolveInitialThreadSidebarWidth(null, 400, 300)).toBe(300);
  });
});

describe("clampThreadSidebarWidth", () => {
  it("widens a stored width below a raised minimum", () => {
    expect(clampThreadSidebarWidth(208, 238, 560)).toBe(238);
  });

  it("keeps widths inside the range and caps wide ones", () => {
    expect(clampThreadSidebarWidth(300, 238, 560)).toBe(300);
    expect(clampThreadSidebarWidth(900, 238, 560)).toBe(560);
  });
});
