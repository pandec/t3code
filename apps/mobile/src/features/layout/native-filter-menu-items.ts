import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";
import type { ColorValue } from "react-native";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import { withNativeGlassHeaderItem } from "./native-glass-header-items";

type NativeHeaderMenuItems = NativeStackHeaderItemMenu["menu"]["items"];
type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

export function sfSymbolIcon(name: string): NativeHeaderIcon {
  return { type: "sfSymbol", name: name as never };
}

export function toNativeHeaderMenuItems(items: HomeListFilterMenu["items"]): NativeHeaderMenuItems {
  return items.map((item) =>
    item.type === "action"
      ? {
          type: "action" as const,
          label: item.title,
          description: item.subtitle,
          onPress: item.onPress,
          state: item.state === "on" ? ("on" as const) : undefined,
        }
      : {
          type: "submenu" as const,
          label: item.title,
          items: toNativeHeaderMenuItems(item.items),
        },
  );
}

/**
 * UINavigationBar toggle for the sticky attention filter. The outlined/filled
 * attention symbol, varying label, and tint communicate state because bar-button
 * items have no native pressed state. Shared by compact Home and split-view
 * sidebar. Disabled (with a loading label) until thread shells are loaded so
 * the snapshot cannot miss late shells.
 */
export function createNativeAttentionFilterHeaderItem(input: {
  readonly enabled: boolean;
  readonly gated: boolean;
  readonly activeTintColor: ColorValue;
  readonly identifier: string;
  readonly onToggle: () => void;
}): NativeStackHeaderItem {
  return withNativeGlassHeaderItem({
    type: "button",
    label: "",
    identifier: input.identifier,
    accessibilityLabel: input.gated
      ? "Loading threads"
      : input.enabled
        ? "Clear attention filter"
        : "Show only threads needing attention",
    disabled: input.gated,
    icon: sfSymbolIcon(input.enabled ? "exclamationmark.circle.fill" : "exclamationmark.circle"),
    onPress: input.onToggle,
    ...(input.enabled ? { tintColor: input.activeTintColor } : {}),
  });
}

/**
 * UINavigationBar item that opens the thread list filter/sort menu. Shared by
 * the compact Home header and the split-view sidebar so both surfaces expose
 * the same environment/project/sort options.
 */
export function createNativeFilterMenuHeaderItem(input: {
  readonly filterIcon: string;
  readonly filterMenu: HomeListFilterMenu;
}): NativeStackHeaderItem {
  return withNativeGlassHeaderItem({
    type: "menu",
    label: "",
    accessibilityLabel: "Filter and sort threads",
    icon: sfSymbolIcon(input.filterIcon),
    menu: {
      title: input.filterMenu.title,
      items: toNativeHeaderMenuItems(input.filterMenu.items),
    },
  });
}
