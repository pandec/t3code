import { ActivityIndicator, Pressable } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import type { WorkspaceState } from "../../state/workspaceModel";
import {
  isWorkspaceConnectionSynchronizing,
  workspaceConnectionStatusLabel,
  workspaceConnectionStatusShortLabel,
} from "./workspace-connection-status";

export function HomeHeaderConnectionStatus(props: {
  readonly state: WorkspaceState;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");

  return (
    <Pressable
      accessibilityHint="Opens environment settings"
      accessibilityLabel={workspaceConnectionStatusLabel(props.state)}
      accessibilityRole="button"
      className="h-9 max-w-[190px] flex-row items-center gap-1.5"
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
    >
      {isWorkspaceConnectionSynchronizing(props.state) ? (
        <ActivityIndicator color={iconColor} size="small" />
      ) : (
        <SymbolView name="wifi.slash" size={15} tintColor={iconColor} type="monochrome" />
      )}
      <Text className="shrink text-base font-t3-bold text-foreground" numberOfLines={1}>
        {workspaceConnectionStatusShortLabel(props.state)}
      </Text>
    </Pressable>
  );
}
