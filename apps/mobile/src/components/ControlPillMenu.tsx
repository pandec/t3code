import { MenuView } from "@react-native-menu/menu";
import {
  cloneElement,
  isValidElement,
  useMemo,
  type ComponentProps,
  type ReactElement,
} from "react";
import type { ColorValue } from "react-native";
import { withUniwind } from "uniwind";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { withMenuActionIconColors } from "../lib/menu-action-colors";
import type { ControlPillMenuProps } from "./ControlPillMenu.types";

const ThemedMenuView = withUniwind(
  function NativeMenuView({
    iconColor,
    destructiveIconColor,
    ...props
  }: ComponentProps<typeof MenuView> & {
    readonly iconColor?: ColorValue;
    readonly destructiveIconColor?: ColorValue;
  }) {
    const actions = useMemo(
      () =>
        withMenuActionIconColors(props.actions, {
          icon: iconColor,
          destructiveIcon: destructiveIconColor,
        }),
      [props.actions, iconColor, destructiveIconColor],
    );
    return <MenuView {...props} actions={actions} />;
  },
  {
    iconColor: { fromClassName: "iconColorClassName", styleProperty: "accentColor" },
    destructiveIconColor: {
      fromClassName: "destructiveIconColorClassName",
      styleProperty: "accentColor",
    },
  },
);

export function ControlPillMenu(props: ControlPillMenuProps) {
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";

  const {
    androidActionAccessibilityRole: _androidActionAccessibilityRole,
    className: _className,
    ...menuProps
  } = props;
  let children = menuProps.children;
  // In long-press mode the wrapped pressable still receives the touch (the
  // patched MenuView button is touch-transparent) and RN's Fabric touch
  // handler is never cancelled by the in-tree UIContextMenuInteraction, so a
  // bare onPress would fire on finger-up even after the menu opened — and
  // also on a long press released just under the menu threshold. A dispatched
  // onLongPress makes Pressability swallow the release, so holds past 350ms
  // (below the ~500ms context-menu threshold) can only open the menu, never
  // tap through.
  //
  // Upstream replaced this with a deferred-press state machine driven by
  // onMenuInteractionStart (configuration time) vs onOpenMenu (display time).
  // The fork's native patch keeps both events at configuration time — its
  // willDisplayMenuFor override degrades button-anchored menus into generic
  // context-menu chrome — which collapses that machine's isPreparing window
  // and lets an aborted menu leave presses suppressed. Rejected until both
  // halves can be verified together on a device.
  if (props.shouldOpenOnLongPress && isValidElement(children)) {
    const child = children as ReactElement<{ onLongPress?: () => void; delayLongPress?: number }>;
    children = cloneElement(child, {
      onLongPress: child.props.onLongPress ?? (() => undefined),
      delayLongPress: child.props.delayLongPress ?? 350,
    });
  }
  return (
    <ThemedMenuView
      {...menuProps}
      iconColorClassName="accent-icon"
      destructiveIconColorClassName="accent-danger-foreground"
      themeVariant={isDarkMode ? "dark" : "light"}
    >
      {children}
    </ThemedMenuView>
  );
}
