import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPendingSidebarResize,
  Sidebar,
  SidebarMenuAction,
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

  it("uses a pointer cursor for menu buttons by default", () => {
    const html = renderSidebarButton();

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("cursor-pointer");
  });

  it("lets project drag handles override the default pointer cursor", () => {
    const html = renderSidebarButton("cursor-grab");

    expect(html).toContain("cursor-grab");
    expect(html).not.toContain("cursor-pointer");
  });

  it("uses a pointer cursor for menu actions", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuAction aria-label="Create thread">
        <span>+</span>
      </SidebarMenuAction>,
    );

    expect(html).toContain('data-slot="sidebar-menu-action"');
    expect(html).toContain("cursor-pointer");
  });

  it("uses a pointer cursor for submenu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuSubButton render={<button type="button" />}>Show more</SidebarMenuSubButton>,
    );

    expect(html).toContain('data-slot="sidebar-menu-sub-button"');
    expect(html).toContain("cursor-pointer");
  });
});
