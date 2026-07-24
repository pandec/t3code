import type { DesktopNotificationThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useMemo, useRef } from "react";

import { toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import {
  useAllEnvironmentShellsBootstrapped,
  useEnvironmentIdsReadyForTurnCompletion,
  useThreadShells,
} from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  advanceTurnCompletionSnapshot,
  buildTurnCompletionCopy,
  filterShellsForTurnCompletion,
  seedTurnCompletionSnapshot,
  type TurnCompletionSnapshot,
} from "./turnCompletion.logic";

export type BrowserNotificationPermissionState =
  | NotificationPermission
  | "unsupported"
  | "insecure";

export function readBrowserNotificationPermissionState(): BrowserNotificationPermissionState {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  if (!window.isSecureContext) {
    return "insecure";
  }
  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermissionState> {
  const current = readBrowserNotificationPermissionState();
  if (current !== "default") {
    return current;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return "unsupported";
  }
}

export function buildNotificationSettingsSupportText(
  permissionState: BrowserNotificationPermissionState,
): string {
  if (isElectron) {
    return "Delivered through your operating system's notification center.";
  }
  switch (permissionState) {
    case "granted":
      return "Browser notifications are enabled for this app.";
    case "denied":
      return "Browser notifications are blocked. Re-enable them in your browser's site settings.";
    case "insecure":
      return "Browser notifications need a secure context. Localhost works; plain HTTP does not.";
    case "unsupported":
      return "This browser does not support system notifications.";
    case "default":
      return "Enabling asks the browser for notification permission.";
  }
}

export function shouldShowTurnCompletionSystemNotification(input: {
  readonly enabled: boolean;
  readonly visibilityState: DocumentVisibilityState;
  readonly hasFocus: boolean;
}): boolean {
  return input.enabled && !(input.visibilityState === "visible" && input.hasFocus);
}

type ShowSystemNotificationInput = {
  readonly title: string;
  readonly body: string;
  readonly threadRef?: DesktopNotificationThreadRef;
  readonly onBrowserNotificationClick?: () => void;
};

/**
 * Best-effort system notification: Electron main process when the desktop
 * bridge is present, Web Notification API otherwise. Resolves false (never
 * throws) when the environment can't deliver one.
 */
export async function showSystemNotification(input: ShowSystemNotificationInput): Promise<boolean> {
  const bridge = window.desktopBridge?.notifications;
  if (bridge) {
    try {
      return await bridge.show({
        title: input.title,
        body: input.body,
        ...(input.threadRef !== undefined ? { threadRef: input.threadRef } : {}),
      });
    } catch {
      return false;
    }
  }

  if (readBrowserNotificationPermissionState() !== "granted") {
    return false;
  }
  try {
    const tag = input.threadRef
      ? `turn-completed:${input.threadRef.environmentId}:${input.threadRef.threadId}`
      : "turn-completed:test";
    const notification = new Notification(input.title, { body: input.body, tag });
    notification.addEventListener("click", () => {
      window.focus();
      input.onBrowserNotificationClick?.();
    });
    return true;
  } catch {
    return false;
  }
}

export function TurnCompletionNotifications() {
  const navigate = useNavigate();
  const toastsEnabled = useClientSettings((settings) => settings.enableTurnCompletionToasts);
  const systemEnabled = useClientSettings(
    (settings) => settings.enableTurnCompletionSystemNotifications,
  );
  const threadShells = useThreadShells();
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const readyEnvironmentIds = useEnvironmentIdsReadyForTurnCompletion();
  const authoritativeThreadShells = useMemo(
    () => filterShellsForTurnCompletion(threadShells, readyEnvironmentIds),
    [readyEnvironmentIds, threadShells],
  );
  const snapshotRef = useRef<TurnCompletionSnapshot | null>(null);

  const navigateToThread = useEffectEvent((threadRef: DesktopNotificationThreadRef) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  });

  useEffect(() => {
    const bridge = window.desktopBridge?.notifications;
    if (!bridge) {
      return;
    }
    return bridge.onNotificationClicked((threadRef) => {
      navigateToThread(threadRef);
    });
  }, [navigateToThread]);

  useEffect(() => {
    if (!shellsBootstrapped) {
      if (snapshotRef.current !== null) {
        // Invalidate comparison baselines without forgetting lifetime turn-ID
        // history if the environment catalog itself reloads.
        snapshotRef.current = { ...snapshotRef.current, shells: [] };
      }
      return;
    }

    // Seed only after the environment catalog has bootstrapped. Each
    // environment is independently filtered out while synchronizing, then
    // re-enters as unseen history without suppressing healthy environments.
    if (snapshotRef.current === null) {
      snapshotRef.current = seedTurnCompletionSnapshot(authoritativeThreadShells);
      return;
    }

    const { snapshot, candidates } = advanceTurnCompletionSnapshot(
      snapshotRef.current,
      authoritativeThreadShells,
    );
    // Always advance, even with both toggles off — re-enabling a toggle must
    // not burst out a backlog of stale completions.
    snapshotRef.current = snapshot;

    if (candidates.length === 0 || (!toastsEnabled && !systemEnabled)) {
      return;
    }

    const notifySystem = shouldShowTurnCompletionSystemNotification({
      enabled: systemEnabled,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
    });
    for (const candidate of candidates) {
      const threadRef: DesktopNotificationThreadRef = {
        environmentId: candidate.environmentId,
        threadId: candidate.threadId,
      };
      const { title, body } = buildTurnCompletionCopy(candidate);
      if (toastsEnabled) {
        toastManager.add({
          type: "success",
          title,
          description: body,
          actionProps: {
            children: "Open thread",
            onClick: () => navigateToThread(threadRef),
          },
        });
      }
      if (notifySystem) {
        void showSystemNotification({
          title,
          body,
          threadRef,
          onBrowserNotificationClick: () => navigateToThread(threadRef),
        });
      }
    }
  }, [
    authoritativeThreadShells,
    shellsBootstrapped,
    toastsEnabled,
    systemEnabled,
    navigateToThread,
  ]);

  return null;
}
