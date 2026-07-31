import { describe, expect, it, vi } from "vite-plus/test";

import { createSidebarHeaderItems } from "./sidebar-native-header-items";

const filterMenu = {
  title: "Thread list options",
  items: [],
} as const;

describe("createSidebarHeaderItems", () => {
  it("puts the attention toggle between settings and the filter menu", () => {
    const items = createSidebarHeaderItems({
      attentionFilterEnabled: true,
      attentionFilterReady: true,
      attentionFilterActiveTintColor: "#007aff",
      showAttentionFilter: true,
      filterIcon: "line.3.horizontal.decrease.circle",
      filterMenu,
      onOpenSettings: vi.fn(),
      onToggleAttentionFilter: vi.fn(),
    });

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      type: "button",
      accessibilityLabel: "Open settings",
    });
    expect(items[1]).toMatchObject({
      type: "button",
      accessibilityLabel: "Clear attention filter",
      icon: { type: "sfSymbol", name: "line.3.horizontal.decrease" },
      tintColor: "#007aff",
    });
    expect(items[2]).toMatchObject({
      type: "menu",
      accessibilityLabel: "Filter and sort threads",
    });
  });

  it("omits the attention toggle when Thread List v2 is disabled", () => {
    const items = createSidebarHeaderItems({
      attentionFilterEnabled: false,
      attentionFilterReady: true,
      attentionFilterActiveTintColor: "#007aff",
      showAttentionFilter: false,
      filterIcon: "line.3.horizontal.decrease.circle",
      filterMenu,
      onOpenSettings: vi.fn(),
      onToggleAttentionFilter: vi.fn(),
    });

    expect(items).toHaveLength(2);
  });
});
