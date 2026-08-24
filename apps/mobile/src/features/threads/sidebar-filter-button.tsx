import { SymbolView } from "../../components/AppSymbol";
import { Pressable } from "react-native";

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
  readonly onPress?: () => void;
}) {
  const iconColor = useThemeColor("--color-foreground");
  const primaryColor = useThemeColor("--color-primary");

  return (
    <Pressable
      className="size-11 cursor-pointer items-center justify-center rounded-full bg-subtle active:opacity-70"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole={props.onPress ? "togglebutton" : "button"}
      accessibilityState={
        props.onPress ? { checked: props.active ?? false, disabled: props.disabled } : undefined
      }
      disabled={props.disabled}
      hitSlop={4}
      onPress={props.onPress}
      style={props.disabled ? { opacity: 0.45 } : null}
    >
      <SymbolView
        name={props.icon}
        size={16}
        tintColor={props.active ? primaryColor : iconColor}
        type="monochrome"
      />
    </Pressable>
  );
}
