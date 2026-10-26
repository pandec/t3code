import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useRef } from "react";
import { Pressable } from "react-native";

import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";

const ATTACHMENT_MENU_ACTIONS: MenuAction[] = [
  { id: "photos", title: "Photo Library", image: "photo" },
  { id: "files", title: "Choose Files", image: "folder" },
];

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
  readonly onOverlayVisibilityChange?: (visible: boolean) => void;
}) {
  const { disabled, onOverlayVisibilityChange } = props;
  const pickerActiveRef = useRef(false);
  const runPicker = useCallback(
    async (pick: () => Promise<void>) => {
      if (disabled) return;
      pickerActiveRef.current = true;
      onOverlayVisibilityChange?.(true);
      try {
        await pick();
      } finally {
        pickerActiveRef.current = false;
        onOverlayVisibilityChange?.(false);
      }
    },
    [disabled, onOverlayVisibilityChange],
  );
  const markMenuVisible = useCallback(
    () => onOverlayVisibilityChange?.(true),
    [onOverlayVisibilityChange],
  );
  const handleMenuClosed = useCallback(() => {
    if (!pickerActiveRef.current) onOverlayVisibilityChange?.(false);
  }, [onOverlayVisibilityChange]);

  const { scale } = useAndroidControlSizing();
  const button = (
    <Pressable
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      onPress={props.supportsFiles ? undefined : () => void runPicker(props.onPickMedia)}
    >
      <SymbolView
        name="plus"
        size={Math.round((props.size === "large" ? 26 : 20) * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  if (props.disabled || !props.supportsFiles) {
    return button;
  }

  return (
    <Menu
      accessible
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      actions={ATTACHMENT_MENU_ACTIONS}
      onMenuInteractionStart={markMenuVisible}
      onOpenMenu={markMenuVisible}
      onCloseMenu={handleMenuClosed}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "photos") {
          void runPicker(props.onPickMedia);
        } else if (nativeEvent.event === "files") {
          void runPicker(props.onPickFiles);
        }
      }}
    >
      {button}
    </Menu>
  );
}
