import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPendingSidebarResize,
  parseSidebarPixelWidth,
  Sidebar,
  SidebarMenuButton,
  SidebarMenuSubButton,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "./sidebar";
import { resolveSidebarState } from "./sidebarState";

function renderSidebarButton(className?: string) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenuButton className={className}>Projects</SidebarMenuButton>
    </SidebarProvider>,
  );
}

// The options a drag captured at pointer-down. applyPendingSidebarResize takes
// the options to apply explicitly, so these only need to satisfy the type.
const resizeOptions = {
  maxWidth: 600,
  minWidth: 208,
  storageKey: null,
} as const;

describe("sidebar interactive cursors", () => {
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

  it("exposes collapsed state for shared titlebar inset styling", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false}>
        <div />
      </SidebarProvider>,
    );

    expect(html).toContain('data-sidebar-state="collapsed"');
  });

  it("keeps the sidebar trigger interactive inside Electron drag regions", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain("[-webkit-app-region:no-drag]");
    expect(html).toContain("size-[var(--workspace-titlebar-control-size)]!");
  });

  it("keeps the sidebar resize rail interactive inside Electron drag regions", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <Sidebar resizable>
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>,
    );

    expect(html).toContain('data-slot="sidebar-rail"');
    expect(html).toContain("[-webkit-app-region:no-drag]");
  });

  it("uses shared geometry and icon constraints for menu buttons by default", () => {
    const html = renderSidebarButton();

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("h-8");
    expect(html).toContain("rounded-[var(--control-radius)]");
    expect(html).toContain("px-[var(--sidebar-row-content-inset)]");
    expect(html).toContain("py-1.5");
    expect(html).toContain("]:size-4");
    expect(html).toContain("]:shrink-0");
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("gap-[var(--sidebar-control-gap)]");
    expect(html).toContain("text-[var(--sidebar-icon-color)]");
    expect(html).not.toContain("[&amp;&gt;svg]:opacity-60");
  });

  it("applies the shared default treatment to icon-only menu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenuButton size="icon">
          <span>+</span>
        </SidebarMenuButton>
      </SidebarProvider>,
    );

    expect(html).toContain("size-8");
    expect(html).toContain("justify-center");
    expect(html).toContain("p-0");
    expect(html).toContain("font-medium");
    expect(html).toContain("text-sidebar-muted-foreground/80");
  });

  it("lets project drag handles override the default pointer cursor", () => {
    const html = renderSidebarButton("cursor-grab");

    expect(html).toContain("cursor-grab");
    expect(html).not.toContain("cursor-pointer");
  });

  it("uses a pointer cursor for submenu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuSubButton render={<button type="button" />}>Show more</SidebarMenuSubButton>,
    );

    expect(html).toContain('data-slot="sidebar-menu-sub-button"');
    expect(html).toContain("cursor-pointer");
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
