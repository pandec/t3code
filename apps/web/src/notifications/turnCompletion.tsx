import type { DesktopNotificationThreadRef, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useMemo, useRef } from "react";

import { toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import {
  getClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
  useTurnCompletionMinDurationSeconds,
} from "../hooks/useSettings";
import { useEnvironmentIdsReadyForTurnCompletion, useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  type NotificationSoundKind,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import {
  buildInputRequestCopy,
  collectInputRequestCandidates,
  type InputRequestCandidate,
} from "./inputRequest.logic";
import {
  advanceTurnCompletionSnapshot,
  buildTurnCompletionCopy,
  filterShellsForTurnCompletion,
  filterTurnCompletionCandidatesByDuration,
  resolveTurnCompletionCandidatesForDelivery,
  seedTurnCompletionSnapshot,
  type TurnCompletionCandidate,
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
  readonly tag?: string;
  /** Suppress the OS sound when the app plays its own. */
  readonly silent?: boolean;
  readonly onBrowserNotificationClick?: () => void;
  readonly onBrowserNotification?: (notification: Notification) => void;
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
        ...(input.silent !== undefined ? { silent: input.silent } : {}),
      });
    } catch {
      return false;
    }
  }

  if (readBrowserNotificationPermissionState() !== "granted") {
    return false;
  }
  try {
    const tag =
      input.tag ??
      (input.threadRef
        ? `turn-completed:${input.threadRef.environmentId}:${input.threadRef.threadId}`
        : "turn-completed:test");
    const notification = new Notification(input.title, {
      body: input.body,
      tag,
      ...(input.silent !== undefined ? { silent: input.silent } : {}),
    });
    input.onBrowserNotification?.(notification);
    notification.addEventListener("click", () => {
      window.focus();
      input.onBrowserNotificationClick?.();
    });
    return true;
  } catch {
    return false;
  }
}

type Announcement = {
  readonly threadRef: DesktopNotificationThreadRef;
  readonly title: string;
  readonly body: string;
  readonly sound: NotificationSoundKind;
  readonly tag: string;
  readonly failed?: boolean;
};

function completionAnnouncement(candidate: TurnCompletionCandidate): Announcement {
  const threadRef = { environmentId: candidate.environmentId, threadId: candidate.threadId };
  return {
    threadRef,
    ...buildTurnCompletionCopy(candidate),
    sound: "completion",
    tag: `turn-completed:${threadRef.environmentId}:${threadRef.threadId}`,
  };
}

function inputRequestAnnouncement(candidate: InputRequestCandidate): Announcement {
  const threadRef = { environmentId: candidate.environmentId, threadId: candidate.threadId };
  return {
    threadRef,
    ...buildInputRequestCopy(candidate),
    failed: candidate.kind === "failed",
    sound: "input",
    tag: `input-requested:${threadRef.environmentId}:${threadRef.threadId}`,
  };
}

/**
 * The one client-side notification coordinator: turn completions and
 * input/approval requests and failures share the same shell snapshot, the same replay
 * guards, and the same delivery channels (toast, background-only system
 * notification, optional sound).
 */
export function TurnCompletionNotifications() {
  const navigate = useNavigate();
  const toastsEnabled = useClientSettings((settings) => settings.enableTurnCompletionToasts);
  const systemEnabled = useClientSettings(
    (settings) => settings.enableTurnCompletionSystemNotifications,
  );
  const inputRequestsEnabled = useClientSettings(
    (settings) => settings.enableInputRequestNotifications,
  );
  const soundsEnabled = useClientSettings((settings) => settings.enableNotificationSounds);
  const minDurationSeconds = useTurnCompletionMinDurationSeconds();
  const settingsHydrated = useClientSettingsHydrated();
  const threadShells = useThreadShells();
  const readyEnvironmentIds = useEnvironmentIdsReadyForTurnCompletion();
  const authoritativeThreadShells = useMemo(
    () => filterShellsForTurnCompletion(threadShells, readyEnvironmentIds),
    [readyEnvironmentIds, threadShells],
  );
  const snapshotRef = useRef<TurnCompletionSnapshot | null>(null);
  const pendingCandidatesRef = useRef<TurnCompletionCandidate[]>([]);
  const { environments } = useEnvironments();
  const activeEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const activeEnvironmentIdsRef = useRef(activeEnvironmentIds);
  activeEnvironmentIdsRef.current = activeEnvironmentIds;
  const pendingNotificationsRef = useRef(
    new Map<string, { environmentId: EnvironmentId; notification?: Notification }>(),
  );
  const badgeEpochRef = useRef(0);

  useEffect(() => {
    const clear = () => {
      badgeEpochRef.current++;
      for (const pending of pendingNotificationsRef.current.values()) pending.notification?.close();
      pendingNotificationsRef.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!systemEnabled) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [systemEnabled]);

  useEffect(() => {
    let changed = false;
    for (const [key, pending] of pendingNotificationsRef.current) {
      if (activeEnvironmentIds.has(pending.environmentId)) continue;
      pending.notification?.close();
      pendingNotificationsRef.current.delete(key);
      changed = true;
    }
    if (changed) setNotificationBadge(pendingNotificationsRef.current.size);
  }, [activeEnvironmentIds]);

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
    // Browsers only let audio start from a gesture; arm the context on the
    // first interaction so a later background completion can still play.
    if (!soundsEnabled) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [soundsEnabled]);

  useEffect(() => {
    // Only authoritative environments enter the baseline. Each environment
    // independently enters as unseen history, so initial sync, additions, and
    // reconnect replay stay silent without pausing healthy environments.
    if (snapshotRef.current === null) {
      snapshotRef.current = seedTurnCompletionSnapshot(authoritativeThreadShells);
      return;
    }

    // Input requests are pure transitions between consecutive snapshots, so
    // they are read before the snapshot advances.
    const inputRequestCandidates = inputRequestsEnabled
      ? collectInputRequestCandidates(snapshotRef.current.shells, authoritativeThreadShells)
      : [];
    const { snapshot, candidates } = advanceTurnCompletionSnapshot(
      snapshotRef.current,
      authoritativeThreadShells,
    );
    // Always advance, even with every toggle off — re-enabling a toggle must
    // not burst out a backlog of stale completions.
    snapshotRef.current = snapshot;

    const resolvedCandidates = resolveTurnCompletionCandidatesForDelivery(
      pendingCandidatesRef.current,
      candidates,
      settingsHydrated,
    );
    pendingCandidatesRef.current = [...resolvedCandidates.pending];
    // Short turns are dropped after the snapshot advanced, so raising the
    // threshold never resurrects them later; every channel is suppressed
    // together — a toast is as interrupting as a notification here.
    const completionsToDeliver = filterTurnCompletionCandidatesByDuration(
      resolvedCandidates.deliver,
      minDurationSeconds,
    );

    const announcements = [
      ...completionsToDeliver.map(completionAnnouncement),
      ...(settingsHydrated ? inputRequestCandidates.map(inputRequestAnnouncement) : []),
    ];
    if (announcements.length === 0 || (!toastsEnabled && !systemEnabled && !soundsEnabled)) {
      return;
    }

    const notifySystem = shouldShowTurnCompletionSystemNotification({
      enabled: systemEnabled,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
    });
    for (const announcement of announcements) {
      const { threadRef, title, body } = announcement;
      if (toastsEnabled) {
        toastManager.add({
          type: announcement.failed
            ? "error"
            : announcement.sound === "completion"
              ? "success"
              : "info",
          title,
          description: body,
          actionProps: {
            children: "Open thread",
            onClick: () => navigateToThread(threadRef),
          },
        });
      }
      if (soundsEnabled) {
        void playNotificationSound(
          announcement.sound,
          () => getClientSettings().enableNotificationSounds,
        );
      }
      if (notifySystem) {
        const epoch = badgeEpochRef.current;
        let browserNotification: Notification | undefined;
        void showSystemNotification({
          title,
          body,
          threadRef,
          tag: announcement.tag,
          // The in-app sound already played (or was deliberately off).
          silent: soundsEnabled,
          onBrowserNotificationClick: () => navigateToThread(threadRef),
          onBrowserNotification: (notification) => {
            browserNotification = notification;
          },
        }).then((delivered) => {
          if (!delivered) return;
          if (
            epoch !== badgeEpochRef.current ||
            !activeEnvironmentIdsRef.current.has(threadRef.environmentId)
          ) {
            browserNotification?.close();
            return;
          }
          const key = `${threadRef.environmentId}:${threadRef.threadId}`;
          pendingNotificationsRef.current.get(key)?.notification?.close();
          pendingNotificationsRef.current.set(key, {
            environmentId: threadRef.environmentId,
            ...(browserNotification ? { notification: browserNotification } : {}),
          });
          setNotificationBadge(pendingNotificationsRef.current.size);
        });
      }
    }
  }, [
    authoritativeThreadShells,
    inputRequestsEnabled,
    minDurationSeconds,
    settingsHydrated,
    soundsEnabled,
    toastsEnabled,
    systemEnabled,
    navigateToThread,
  ]);

  return null;
}
