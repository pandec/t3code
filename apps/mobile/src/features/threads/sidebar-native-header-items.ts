import type { NativeStackHeaderItem } from "@react-navigation/native-stack";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import { createNativeFilterMenuHeaderItem, sfSymbolIcon } from "../layout/native-filter-menu-items";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

/**
 * Right-side UINavigationBar items for the sidebar column: the thread list
 * filter/sort menu plus the settings button, sharing one glass capsule —
 * the Messages-style grouped header buttons.
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
