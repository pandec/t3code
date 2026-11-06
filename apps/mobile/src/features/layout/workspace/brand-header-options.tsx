import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Platform } from "react-native";

import { brandTitleOffset, CompactBrandTitle } from "../../../components/CompactBrandTitle";
import { WorkspaceConnectionTitle } from "../../home/WorkspaceConnectionTitle";

function renderCompactBrandTitle() {
  return <CompactBrandTitle allowFontScaling={Platform.OS === "ios"} />;
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  return {
    headerTitle: renderCompactBrandTitle,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
    unstable_headerLeftItems: undefined,
  };
}

export function getConnectionAwareBrandHeaderOptions(opts: {
  readonly headerWidth: number;
  readonly trailingItemCount?: number;
  readonly onOpenEnvironments: () => void;
  readonly fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"];
  /** Fork: show the background prewarm indicator beside the brand (thread list only). */
  readonly showThreadSync?: boolean;
}): NativeStackNavigationOptions {
  const maxWidth = Math.max(0, opts.headerWidth - 64 - 44 * (opts.trailingItemCount ?? 1));

  return {
    ...getCompactBrandHeaderOptions(opts.fallbackTitleStyle),
    headerTitle: () => (
      <WorkspaceConnectionTitle
        brand={<CompactBrandTitle />}
        maxWidth={maxWidth}
        onPress={opts.onOpenEnvironments}
        showThreadSync={opts.showThreadSync}
        statusOffset={brandTitleOffset()}
      />
    ),
  };
}
