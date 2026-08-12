// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares shipped CSS with the sidebar width contract.
import * as NodeFS from "node:fs";

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
    const sidebarStyles = NodeFS.readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const desktopHeaderStyles = sidebarStyles.slice(
      sidebarStyles.indexOf("@media (min-width: 48rem)"),
      sidebarStyles.indexOf("/* Stage-channel sidebar art"),
    );
    const stageLabelThreshold = desktopHeaderStyles.match(
      /@container sidebar-header \(min-width: ([\d.]+)rem\) \{\s*\.sidebar-brand-stage \{\s*display: inline-flex;/,
    )?.[1];

    expect(sidebarStyles).toMatch(/\.sidebar-brand \{\s*display: none;/);
    expect(desktopHeaderStyles).toMatch(
      /@media \(min-width: 48rem\) \{\s*\.sidebar-brand \{\s*display: flex;/,
    );
    expect(THREAD_SIDEBAR_MIN_WIDTH).toBe(13 * 16);
    expect(Number(stageLabelThreshold) * 16).toBeGreaterThan(THREAD_SIDEBAR_MIN_WIDTH);
  });
});
