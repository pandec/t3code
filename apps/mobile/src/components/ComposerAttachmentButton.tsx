import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useRef } from "react";
import { Pressable } from "react-native";

import { SymbolView } from "./AppSymbol";
import { ControlPillMenu } from "./ControlPill";

const ATTACHMENT_MENU_ACTIONS: MenuAction[] = [
  { id: "photos", title: "Photo Library", image: "photo" },
  { id: "files", title: "Choose Files", image: "folder" },
];

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
  readonly onOverlayVisibilityChange?: (visible: boolean) => void;
}) {
  const pickerActiveRef = useRef(false);
  const runPicker = useCallback(
    async (pick: () => Promise<void>) => {
      if (props.disabled) return;
      pickerActiveRef.current = true;
      props.onOverlayVisibilityChange?.(true);
      try {
        await pick();
      } finally {
        pickerActiveRef.current = false;
        props.onOverlayVisibilityChange?.(false);
      }
    },
    [props.disabled, props.onOverlayVisibilityChange],
  );
  const markMenuVisible = useCallback(
    () => props.onOverlayVisibilityChange?.(true),
    [props.onOverlayVisibilityChange],
  );
  const handleMenuClosed = useCallback(() => {
    if (!pickerActiveRef.current) props.onOverlayVisibilityChange?.(false);
  }, [props.onOverlayVisibilityChange]);

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
        size={20}
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
    <ControlPillMenu
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
    </ControlPillMenu>
  );
}
