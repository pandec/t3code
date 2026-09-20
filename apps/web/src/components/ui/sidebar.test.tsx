import { describe, expect, it } from "vite-plus/test";

import { applyPendingSidebarResize, parseSidebarPixelWidth } from "./sidebar";
import { resolveSidebarState } from "./sidebarState";

// The options a drag captured at pointer-down. applyPendingSidebarResize takes
// the options to apply explicitly, so these only need to satisfy the type.
const resizeOptions = {
  maxWidth: 600,
  minWidth: 208,
  storageKey: null,
} as const;

describe("sidebar resize and responsive state", () => {
  it("commits the latest pending width before a queued animation frame can run", () => {
    const appliedWidths: string[] = [];
    const wrapper = {
      style: {
        setProperty: (property: string, value: string) => {
          if (property === "--sidebar-width") {
            appliedWidths.push(value);
          }
        },
      },
    } as unknown as HTMLElement;
    const resizeState = {
      moved: true,
      options: resizeOptions,
      pointerId: 1,
      pendingWidth: 320,
      rail: {} as HTMLButtonElement,
      rafId: 1,
      sidebarRoot: {} as HTMLElement,
      side: "left" as const,
      startWidth: 208,
      startX: 208,
      transitionTargets: [],
      width: 208,
      wrapper,
    };

    expect(
      applyPendingSidebarResize(resizeState, {
        maxWidth: 600,
        minWidth: 208,
        storageKey: null,
      }),
    ).toBe(true);
    expect(appliedWidths).toEqual(["320px"]);
    expect(resizeState.width).toBe(320);
  });

  it("keeps the current width when the pending resize is rejected", () => {
    const wrapper = {
      style: {
        setProperty: () => {
          throw new Error("Rejected widths must not be applied");
        },
      },
    } as unknown as HTMLElement;
    const resizeState = {
      moved: true,
      options: resizeOptions,
      pointerId: 1,
      pendingWidth: 720,
      rail: {} as HTMLButtonElement,
      rafId: 1,
      sidebarRoot: {} as HTMLElement,
      side: "left" as const,
      startWidth: 208,
      startX: 208,
      transitionTargets: [],
      width: 320,
      wrapper,
    };

    expect(
      applyPendingSidebarResize(resizeState, {
        maxWidth: 720,
        minWidth: 208,
        shouldAcceptWidth: () => false,
        storageKey: null,
      }),
    ).toBe(false);
    expect(resizeState.width).toBe(320);
  });

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
