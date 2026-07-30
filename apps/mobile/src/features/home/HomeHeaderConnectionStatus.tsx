import { ActivityIndicator, Pressable } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import type { WorkspaceConnectionStatusPresentation } from "./workspace-connection-status";

export function HomeHeaderConnectionStatus(props: {
  readonly presentation: WorkspaceConnectionStatusPresentation;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");

  return (
    <Pressable
      accessibilityHint="Opens environment settings"
      accessibilityLabel={props.presentation.fullLabel}
      accessibilityRole="button"
      className="h-11 max-w-[190px] flex-row items-center gap-1.5"
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
    >
      {props.presentation.synchronizing ? (
        <ActivityIndicator color={iconColor} size="small" />
      ) : (
        <SymbolView name="wifi.slash" size={15} tintColor={iconColor} type="monochrome" />
      )}
      <Text
        className="shrink text-base font-t3-bold text-foreground"
        maxFontSizeMultiplier={1.2}
        numberOfLines={1}
      >
        {props.presentation.shortLabel}
      </Text>
    </Pressable>
  );
}
