import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

export function ThreadCustomGroupHeader(props: {
  name: string;
  count: number;
  expanded: boolean;
  /** The built-in Active group: tray icon and a stronger label. */
  builtIn?: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.name}
      accessibilityState={{ expanded: props.expanded }}
      onPress={props.onToggle}
      className="mx-4 mt-3 mb-1 flex-row items-center gap-2 py-2"
    >
      {props.builtIn ? (
        <SymbolView name="tray" size={12} tintColorClassName="accent-foreground-secondary" />
      ) : null}
      <Text
        numberOfLines={1}
        style={{ flexShrink: 1 }}
        className={
          props.builtIn
            ? "text-sm font-t3-medium text-foreground-secondary"
            : "text-sm text-foreground-muted"
        }
      >
        {props.name}
        {!props.expanded ? ` (${props.count})` : ""}
      </Text>
      <View className="h-px flex-1 bg-border" />
      <SymbolView
        name={props.expanded ? "chevron.up" : "chevron.down"}
        size={12}
        tintColorClassName="accent-foreground-muted"
      />
    </Pressable>
  );
}
