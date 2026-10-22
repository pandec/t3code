import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import { sfSymbolIcon, toNativeHeaderMenuItems } from "../layout/native-filter-menu-items";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

function createSidebarFilterHeaderItem(input: {
  readonly filterIcon: string;
  readonly filterMenu: HomeListFilterMenu;
}): NativeStackHeaderItemMenu {
  return withNativeGlassHeaderItem({
    type: "menu",
    axisBehavior: "horizontalOnly",
    label: "",
    accessibilityLabel: "Filter and sort threads",
    icon: sfSymbolIcon(input.filterIcon),
    menu: {
      title: input.filterMenu.title,
      items: toNativeHeaderMenuItems(input.filterMenu.items),
    },
  });
}

/**
 * Right-side UINavigationBar items for the sidebar column: settings, then the
 * thread list filter/sort menu, sharing one glass capsule. The filter sits
 * closest to the trailing edge to match the compact Home header. The embedded
 * sidebar keeps these beside its title; only the detail column uses the Duo's
 * vertical bar.
 */
export function createSidebarHeaderItems(input: {
  readonly filterIcon: string;
  readonly filterMenu: HomeListFilterMenu;
  readonly onOpenSettings: () => void;
}): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      type: "button",
      axisBehavior: "horizontalOnly",
      label: "Settings",
      accessibilityLabel: "Open settings",
      icon: sfSymbolIcon("gearshape"),
      onPress: input.onOpenSettings,
    }),
    createSidebarFilterHeaderItem(input),
  ];
}
