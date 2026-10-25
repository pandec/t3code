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
import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { withMenuActionIconColors } from "../../lib/menu-action-colors";
import type { MenuProps } from "./Menu.types";

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

export function Menu(props: MenuProps) {
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";

  const {
    androidActionAccessibilityRole: _androidActionAccessibilityRole,
    className: _className,
    ...menuProps
  } = props;
  let children = menuProps.children;
  // The patched MenuView button is touch-transparent, so a bare onPress would fire on finger-up after
  // the menu opened; a dispatched onLongPress at 350ms (< ~500ms menu threshold) swallows that release.
  // Upstream's deferred-press machine needs onOpenMenu at display time, which the fork's native patch
  // moves to configuration time; rejected until both halves are verified together on a device.
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
