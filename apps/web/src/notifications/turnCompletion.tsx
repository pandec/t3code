import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { DesktopNotificationThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import { useAllEnvironmentShellsBootstrapped, useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { buildTurnCompletionCopy, collectTurnCompletionCandidates } from "./turnCompletion.logic";

export type BrowserNotificationPermissionState =
  | NotificationPermission
  | "unsupported"
  | "insecure";

export function readBrowserNotificationPermissionState(): BrowserNotificationPermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) {
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

function isWindowForeground(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
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
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const previousShellsRef = useRef<ReadonlyArray<EnvironmentThreadShell> | null>(null);

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
    // Seed only from a fully bootstrapped shell list: everything present at
    // startup — including already-completed turns replayed from cache or the
    // server snapshot — is history, not news.
    if (previousShellsRef.current === null) {
      if (bootstrapped) {
        previousShellsRef.current = threadShells;
      }
      return;
    }

    const candidates = collectTurnCompletionCandidates(previousShellsRef.current, threadShells);
    // Always advance, even with both toggles off — re-enabling a toggle must
    // not burst out a backlog of stale completions.
    previousShellsRef.current = threadShells;

    if (candidates.length === 0 || (!toastsEnabled && !systemEnabled)) {
      return;
    }

    const notifySystem = systemEnabled && !isWindowForeground();
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
  }, [bootstrapped, threadShells, toastsEnabled, systemEnabled, navigateToThread]);

  return null;
}
