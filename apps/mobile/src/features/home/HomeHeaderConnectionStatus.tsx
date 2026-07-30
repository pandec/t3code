import { ActivityIndicator, Pressable, Text as RNText } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import type { WorkspaceConnectionStatusPresentation } from "./workspace-connection-status";

export function HomeHeaderConnectionStatus(props: {
  readonly presentation: WorkspaceConnectionStatusPresentation | null;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const titleColor = useThemeColor("--color-foreground");
  const presentation = props.presentation;

  return (
    <Pressable
      accessibilityHint="Opens environment settings"
      accessibilityLabel={presentation?.fullLabel ?? "Threads"}
      accessibilityRole="button"
      className="h-11 max-w-[190px] flex-row items-center gap-1.5"
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
    >
      {presentation === null ? (
        // Settled: mirror the native stack title (system font, 18/800 — see
        // GLASS_HEADER_OPTIONS in Stack.tsx) so the header looks unchanged
        // while staying tappable.
        <RNText
          maxFontSizeMultiplier={1.2}
          style={{ color: titleColor, fontSize: 18, fontWeight: "800" }}
        >
          Threads
        </RNText>
      ) : (
        <>
          {presentation.synchronizing ? (
            <ActivityIndicator color={iconColor} size="small" />
          ) : (
            <SymbolView name="wifi.slash" size={15} tintColor={iconColor} type="monochrome" />
          )}
          <Text
            className="shrink text-base font-t3-bold text-foreground"
            maxFontSizeMultiplier={1.2}
            numberOfLines={1}
          >
            {presentation.shortLabel}
          </Text>
        </>
      )}
    </Pressable>
  );
}
