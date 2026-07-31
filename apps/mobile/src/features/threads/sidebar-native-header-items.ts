import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import type { ColorValue } from "react-native";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import {
  createNativeAttentionFilterHeaderItem,
  createNativeFilterMenuHeaderItem,
  sfSymbolIcon,
} from "../layout/native-filter-menu-items";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

/**
 * Right-side UINavigationBar items for the sidebar column: settings, attention,
 * then the thread list filter/sort menu, sharing one glass capsule. The filter
 * sits closest to the trailing edge to match the compact Home header.
 */
export function createSidebarHeaderItems(input: {
  readonly attentionFilterEnabled: boolean;
  readonly attentionFilterReady: boolean;
  readonly attentionFilterActiveTintColor: ColorValue;
  readonly showAttentionFilter: boolean;
  readonly filterIcon: string;
  readonly filterMenu: HomeListFilterMenu;
  readonly onOpenSettings: () => void;
  readonly onToggleAttentionFilter: () => void;
}): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      type: "button",
      label: "",
      accessibilityLabel: "Open settings",
      icon: sfSymbolIcon("gearshape"),
      onPress: input.onOpenSettings,
    }),
    ...(input.showAttentionFilter
      ? [
          createNativeAttentionFilterHeaderItem({
            enabled: input.attentionFilterEnabled,
            gated: !input.attentionFilterReady && !input.attentionFilterEnabled,
            activeTintColor: input.attentionFilterActiveTintColor,
            identifier: "sidebar-attention-filter",
            onToggle: input.onToggleAttentionFilter,
          }),
        ]
      : []),
    createNativeFilterMenuHeaderItem({
      filterIcon: input.filterIcon,
      filterMenu: input.filterMenu,
    }),
  ];
}
