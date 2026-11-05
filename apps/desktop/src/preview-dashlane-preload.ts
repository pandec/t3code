import { contextBridge, ipcRenderer } from "electron";

import {
  DASHLANE_ACTION_CHANNEL,
  DASHLANE_ACTIVE_TAB_CHANNEL,
  DASHLANE_EXTENSION_ID,
  DASHLANE_OPEN_TAB_CHANNEL,
  DASHLANE_TAB_FOCUS_CHANNEL,
  installDashlaneApiShim,
  type DashlaneActionMessage,
} from "./preview/DashlaneApiShim.ts";

// Popup windows join Dashlane's existing extension process, so their opener tab arrives over IPC, not argv.
const activeTabId: unknown =
  process.type === "renderer" && window.top === window
    ? ipcRenderer.sendSync(DASHLANE_ACTIVE_TAB_CHANNEL)
    : undefined;

const openTab = (url: string): Promise<unknown> =>
  ipcRenderer.invoke(DASHLANE_OPEN_TAB_CHANNEL, url);

const onTabFocus = (focused: (tabId: number) => void): void => {
  ipcRenderer.on(DASHLANE_TAB_FOCUS_CHANNEL, (_event, tabId: unknown) => {
    if (typeof tabId === "number") focused(tabId);
  });
};

const onAction = (message: DashlaneActionMessage): void =>
  ipcRenderer.send(DASHLANE_ACTION_CHANNEL, message);

// Popups and the background open Dashlane's pages; other extension frames keep Chrome's own tab APIs.
contextBridge.executeInMainWorld({
  func: installDashlaneApiShim,
  args:
    typeof activeTabId === "number"
      ? [DASHLANE_EXTENSION_ID, activeTabId, openTab]
      : process.type === "service-worker"
        ? [DASHLANE_EXTENSION_ID, undefined, openTab, onTabFocus, onAction]
        : [DASHLANE_EXTENSION_ID],
});
