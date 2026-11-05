import {
  browserExtensionSettings,
  updateBrowserExtensionSettings,
  type DesktopPreviewExtensionAction,
} from "@t3tools/contracts";
import { PuzzleIcon } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { persistClientSettingsUpdate, useClientSettings } from "~/hooks/useSettings";
import { previewBridge } from "./previewBridge";

const extensionsBridge = previewBridge?.extensions ?? null;

interface PreviewExtensionItem extends DesktopPreviewExtensionAction {
  readonly pinned: boolean;
}

export interface PreviewExtensions {
  readonly items: ReadonlyArray<PreviewExtensionItem>;
  /** The control unpinned popups open under, like Chrome's extensions menu. */
  readonly menuAnchorRef: RefObject<HTMLButtonElement | null>;
  readonly buttonRef: (extensionId: string) => (element: HTMLElement | null) => void;
  readonly open: (extensionId: string, anchor: Element) => void;
  readonly setPinned: (extensionId: string, pinned: boolean) => void;
}

const sameActions = (
  left: ReadonlyArray<DesktopPreviewExtensionAction>,
  right: ReadonlyArray<DesktopPreviewExtensionAction>,
) =>
  left.length === right.length &&
  left.every((action, index) => {
    const other = right[index]!;
    return (
      action.id === other.id &&
      action.name === other.name &&
      action.title === other.title &&
      action.icon === other.icon
    );
  });

const anchorRect = (element: Element) => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};

/** The extensions running in a desktop preview tab, or null where extensions are unavailable. */
export function usePreviewExtensions(webContentsId: number | null): PreviewExtensions | null {
  const [loaded, setLoaded] = useState<{
    readonly webContentsId: number;
    readonly actions: ReadonlyArray<DesktopPreviewExtensionAction>;
  } | null>(null);
  const settings = useClientSettings((current) => current.browserExtensions);
  // Without an enabled extension nothing runs, so tab switches skip the request and its render.
  const anyEnabled = Object.values(settings).some((extension) => extension.enabled);
  const buttons = useRef(new Map<string, HTMLElement>());
  const menuAnchorRef = useRef<HTMLButtonElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the actions the desktop pushes for this guest
  useEffect(() => {
    if (extensionsBridge === null || webContentsId === null || !anyEnabled) return;
    let active = true;
    let latest = 0;
    const load = () => {
      latest += 1;
      const request = latest;
      extensionsBridge.listActions(webContentsId).then(
        (actions) => {
          if (!active || request !== latest) return;
          setLoaded((current) =>
            current?.webContentsId === webContentsId && sameActions(current.actions, actions)
              ? current
              : { webContentsId, actions },
          );
        },
        () => undefined,
      );
    };
    load();
    const stopChanges = extensionsBridge.onActionsChange((changed) => {
      if (changed === null || changed === webContentsId) load();
    });
    const stopRequests = extensionsBridge.onPopupRequest((request) => {
      if (request.webContentsId !== webContentsId) return;
      const anchor = buttons.current.get(request.extensionId) ?? menuAnchorRef.current;
      if (anchor === null) return;
      void extensionsBridge.openPopup(webContentsId, request.extensionId, anchorRect(anchor));
    });
    return () => {
      active = false;
      stopChanges();
      stopRequests();
    };
  }, [webContentsId, anyEnabled]);

  if (extensionsBridge === null || webContentsId === null || !anyEnabled) return null;
  if (loaded?.webContentsId !== webContentsId) return null;
  return {
    items: loaded.actions.map((action) => ({
      ...action,
      pinned: browserExtensionSettings(settings, action.id).pinned,
    })),
    menuAnchorRef,
    buttonRef: (extensionId) => (element) => {
      if (element) buttons.current.set(extensionId, element);
      else buttons.current.delete(extensionId);
    },
    open: (extensionId, anchor) =>
      void extensionsBridge.openPopup(webContentsId, extensionId, anchorRect(anchor)),
    setPinned: (extensionId, pinned) =>
      void persistClientSettingsUpdate((current) => ({
        ...current,
        browserExtensions: updateBrowserExtensionSettings(current.browserExtensions, extensionId, {
          pinned,
        }),
      })),
  };
}

export function PreviewExtensionIcon({ item }: { readonly item: PreviewExtensionItem }) {
  return item.icon ? (
    <img src={item.icon} alt="" draggable={false} className="size-4 shrink-0" />
  ) : (
    <PuzzleIcon />
  );
}

export function PreviewExtensionButtons({
  extensions,
}: {
  readonly extensions: PreviewExtensions;
}) {
  return extensions.items
    .filter((item) => item.pinned)
    .map((item) => (
      <Tooltip key={item.id}>
        <TooltipTrigger
          render={
            <Button
              ref={extensions.buttonRef(item.id)}
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label={item.title}
              onClick={(event) => extensions.open(item.id, event.currentTarget)}
            />
          }
        >
          <PreviewExtensionIcon item={item} />
        </TooltipTrigger>
        <TooltipPopup>{item.title}</TooltipPopup>
      </Tooltip>
    ));
}
