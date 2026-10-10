import { describe, expect, it } from "vite-plus/test";

import { parseSidebarPixelWidth } from "./sidebar";
import { resolveSidebarState } from "./sidebarState";

describe("sidebar responsive state", () => {
  it("uses mobile sheet visibility for the shared responsive state", () => {
    expect(resolveSidebarState({ isMobile: true, open: true, openMobile: false })).toBe(
      "collapsed",
    );
    expect(resolveSidebarState({ isMobile: true, open: false, openMobile: true })).toBe("expanded");
    expect(resolveSidebarState({ isMobile: false, open: true, openMobile: false })).toBe(
      "expanded",
    );
  });
});

describe("sidebar applied width parsing", () => {
  it("reads the pixel width the resize path writes", () => {
    expect(parseSidebarPixelWidth("458px")).toBe(458);
    expect(parseSidebarPixelWidth(" 947.5703125px ")).toBe(947.5703125);
  });

  it("refuses units the resize path never writes, rather than misreading them", () => {
    // "16rem" is the provider default; Number.parseFloat would read it as 16px
    // and collapse the sidebar to its minimum on the next reconcile.
    expect(parseSidebarPixelWidth("16rem")).toBeNull();
    expect(parseSidebarPixelWidth("calc(100vw - 12px)")).toBeNull();
    expect(parseSidebarPixelWidth("")).toBeNull();
  });
});
