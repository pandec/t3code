import { describe, expect, it } from "vite-plus/test";

import { parseSidebarPixelWidth } from "./sidebar";

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
