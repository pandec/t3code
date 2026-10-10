import type { NativeStackHeaderItem } from "@react-navigation/native-stack";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import { createNativeFilterMenuHeaderItem, sfSymbolIcon } from "../layout/native-filter-menu-items";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

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
  const filterItem = createNativeFilterMenuHeaderItem({
    filterIcon: input.filterIcon,
    filterMenu: input.filterMenu,
  });
  return [
    withNativeGlassHeaderItem({
      type: "button",
      axisBehavior: "horizontalOnly",
      label: "Settings",
      accessibilityLabel: "Open settings",
      icon: sfSymbolIcon("gearshape"),
      onPress: input.onOpenSettings,
    }),
    // Keep the filter beside the title on the Duo, like settings.
    filterItem.type === "menu" ? { ...filterItem, axisBehavior: "horizontalOnly" } : filterItem,
  ];
}
