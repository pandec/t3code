import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

export function ThreadCustomGroupHeader(props: {
  name: string;
  count: number;
  expanded: boolean;
  onToggle?: (() => void) | undefined;
}) {
  return (
    <Pressable
      accessibilityRole={props.onToggle ? "button" : "header"}
      accessibilityLabel={props.name}
      accessibilityState={props.onToggle ? { expanded: props.expanded } : {}}
      disabled={!props.onToggle}
      onPress={props.onToggle}
      className="mx-4 mt-3 mb-1 flex-row items-center gap-2 py-2"
    >
      <Text numberOfLines={1} style={{ flexShrink: 1 }} className="text-sm text-foreground-muted">
        {props.name}
        {!props.expanded ? ` (${props.count})` : ""}
      </Text>
      <View className="h-px flex-1 bg-border" />
      {props.onToggle ? (
        <SymbolView
          name={props.expanded ? "chevron.up" : "chevron.down"}
          size={12}
          tintColorClassName="accent-foreground-muted"
        />
      ) : null}
    </Pressable>
  );
}
