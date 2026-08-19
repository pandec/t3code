import { memo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";

/**
 * Header for the fork's Older shelf. Deliberately the quietest of the three
 * shelves: snoozed threads come back on their own and settled ones were
 * finished, but an Older thread is simply one nobody has touched lately, so
 * it borrows the settled shelf's muted idiom rather than a color of its own.
 */
export const ThreadListV2OlderShelfHeader = memo(function ThreadListV2OlderShelfHeader(props: {
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  const mutedColor = useThemeColor("--color-foreground-muted");
  return (
    <Pressable
      accessibilityHint={
        props.expanded ? "Collapses the older threads." : "Expands the older threads."
      }
      accessibilityLabel={props.count === 1 ? "1 older thread" : `${props.count} older threads`}
      accessibilityRole="button"
      accessibilityState={{ expanded: props.expanded }}
      className={cn(
        "mb-1.5 mt-4 flex-row items-center gap-2.5",
        props.pane === "sidebar" ? "px-3" : "px-5",
      )}
      onPress={props.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text className="text-xs font-t3-medium text-foreground-tertiary">
        {props.expanded ? "Older" : `Older (${props.count})`}
      </Text>
      <View className="h-px flex-1 bg-border" />
      <SymbolView
        name="chevron.down"
        size={10}
        tintColor={mutedColor}
        type="monochrome"
        style={{ transform: [{ rotate: props.expanded ? "180deg" : "0deg" }] }}
      />
    </Pressable>
  );
});
