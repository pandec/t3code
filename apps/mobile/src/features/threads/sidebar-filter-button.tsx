import { SymbolView } from "../../components/AppSymbol";
import { Pressable, StyleSheet } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";

export type SidebarFilterButtonIcon =
  | "line.3.horizontal.decrease"
  | "line.3.horizontal.decrease.circle"
  | "line.3.horizontal.decrease.circle.fill"
  | "exclamationmark.circle"
  | "exclamationmark.circle.fill";

export function SidebarFilterButton(props: {
  readonly accessibilityLabel: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly icon: SidebarFilterButtonIcon;
  /** Rendered inside a shared capsule group — no own background/border. */
  readonly grouped?: boolean;
  readonly onPress?: () => void;
}) {
  const iconColor = useThemeColor("--color-foreground");
  const primaryColor = useThemeColor("--color-primary");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const idleBackgroundColor = useThemeColor("--color-glass-surface");
  const borderColor = useThemeColor("--color-header-border");

  return (
    <Pressable
      className="h-11 w-[50px] cursor-pointer items-center justify-center rounded-[22px]"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole={props.onPress ? "togglebutton" : "button"}
      accessibilityState={
        props.onPress ? { checked: props.active ?? false, disabled: props.disabled } : undefined
      }
      disabled={props.disabled}
      hitSlop={4}
      onPress={props.onPress}
      style={({ pressed }) => [
        props.grouped
          ? { backgroundColor: pressed ? pressedBackgroundColor : "transparent", borderWidth: 0 }
          : {
              backgroundColor: pressed ? pressedBackgroundColor : idleBackgroundColor,
              borderColor,
              borderWidth: StyleSheet.hairlineWidth,
            },
        props.disabled ? { opacity: 0.45 } : null,
      ]}
    >
      <SymbolView
        name={props.icon}
        size={20}
        tintColor={props.active ? primaryColor : iconColor}
        type="monochrome"
      />
    </Pressable>
  );
}
