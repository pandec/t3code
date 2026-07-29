import type { NativeStackHeaderItem } from "@react-navigation/native-stack";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import { createNativeFilterMenuHeaderItem, sfSymbolIcon } from "../layout/native-filter-menu-items";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

/**
 * Right-side UINavigationBar items for the sidebar column: the settings button
 * followed by the thread list filter/sort menu, sharing one glass capsule —
 * the Messages-style grouped header buttons. The filter sits closest to the
 * trailing edge to match the compact Home header.
 */
export function createSidebarHeaderItems(input: {
  readonly filterIcon: string;
  readonly filterMenu: HomeListFilterMenu;
  readonly onOpenSettings: () => void;
}): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      type: "button",
      label: "",
      accessibilityLabel: "Open settings",
      icon: sfSymbolIcon("gearshape"),
      onPress: input.onOpenSettings,
    }),
    createNativeFilterMenuHeaderItem({
      filterIcon: input.filterIcon,
      filterMenu: input.filterMenu,
    }),
  ];
}
