import { useAuth, useUser } from "@clerk/expo";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useNavigation } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SymbolView } from "../../components/AppSymbol";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  MAX_ARCHIVED_SECTION_VISIBLE_COUNT,
  MAX_STEER_GRACE_WINDOW_MS,
  MIN_ARCHIVED_SECTION_VISIBLE_COUNT,
  MIN_STEER_GRACE_WINDOW_MS,
} from "@t3tools/contracts/settings";
import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import { setLiveActivityUpdatesEnabled } from "../agent-awareness/liveActivityPreferences";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
} from "../agent-awareness/remoteRegistration";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  didEnvironmentPrewarmRunsAdvance,
  threadPrewarmTriggerCommand,
  type ThreadPrewarmSummary,
  useThreadPrewarmSummary,
} from "../../state/prewarm";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import {
  DEFAULT_SERVER_SETTINGS,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  filterSharedServerPatch,
  findSharedSettingsMismatches,
  pickSharedServerSettings,
  supportsSharedSettingsSync,
} from "@t3tools/client-runtime/state/shared-settings";
import {
  useAlwaysShowPinnedInAttention,
  useArchivedSectionVisibleCount,
  useOlderSectionSettings,
  useSortActiveByLatestUserMessage,
  useSteerGraceWindowMs,
} from "../../state/use-mobile-preferences";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import {
  type AppUpdateCheckState,
  isAppUpdateCheckAvailable,
  registerHiddenUpdateTap,
  runAppUpdateCheck,
} from "../updates/app-updates";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSliderRow } from "./components/SettingsSliderRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import {
  formatOlderSectionAfterDays,
  formatSteerGraceWindowSeconds,
  OLDER_SECTION_AFTER_DAY_STOPS,
  olderSectionAfterDaysAtStop,
  olderSectionAfterDaysStopIndex,
  STEER_GRACE_WINDOW_STEP_MS,
  toStoredArchivedSectionVisibleCount,
  toStoredSteerGraceWindowMs,
} from "./lib/extras-settings";
import { resolveAgentAwarenessPlatformPresentation } from "./SettingsRouteScreen.logic";

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";
type LiveActivityStatus = "checking" | "enabled" | "disabled" | "signed-out" | "linking";

// Reflects whether the relay actually accepted this device's registration.
// The notification and Live Activity switches are gated on this so they can
// never read as enabled when the device cannot receive anything (e.g. the
// registration request timed out).
function useDeviceRegistered(): boolean {
  const status = useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    getAgentAwarenessRegistrationStatus,
    () => "unknown" as const,
  );
  return status === "registered";
}

export function SettingsRouteScreen() {
  const navigation = useNavigation();

  return (
    <>
      <WorkspaceSidebarToolbar />
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Settings" onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions
          options={{
            unstable_headerRightItems:
              Platform.OS === "ios"
                ? () => [
                    withNativeGlassHeaderItem({
                      accessibilityLabel: "Close settings",
                      icon: { name: "xmark", type: "sfSymbol" } as const,
                      identifier: "settings-close",
                      label: "",
                      onPress: () => navigation.goBack(),
                      type: "button",
                    }),
                  ]
                : undefined,
          }}
        />
      )}
      {hasCloudPublicConfig() ? <ConfiguredSettingsRouteScreen /> : <LocalSettingsRouteScreen />}
    </>
  );
}

function LocalSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentCount = Object.keys(savedConnectionsById).length;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title="Configuration">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
            target="SettingsEnvironments"
          />
        </SettingsSection>

        <GeneralSettingsSection />

        <SettingsSection title="Appearance">
          <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
        </SettingsSection>

        <LegacySettingsSection />

        <ArchivedThreadsSettingsSection />

        <AppSettingsSection />
      </ScrollView>
    </View>
  );
}

function ConfiguredSettingsRouteScreen() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const agentAwarenessPushAvailable = supportsAgentAwarenessPush();
  const agentAwarenessPlatform = resolveAgentAwarenessPlatformPresentation(Platform.OS);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>("checking");
  const [liveActivityStatus, setLiveActivityStatus] = useState<LiveActivityStatus>("checking");
  const deviceRegistered = useDeviceRegistered();
  const liveActivitiesPreferenceEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;

  const connections = useMemo(() => Object.values(savedConnectionsById), [savedConnectionsById]);
  const environmentCount = connections.length;
  const accountLabel = useMemo(() => {
    if (!isLoaded) return "Checking";
    if (!isSignedIn) return "Sign in";
    return user?.primaryEmailAddress?.emailAddress ?? "Signed in";
  }, [isLoaded, isSignedIn, user?.primaryEmailAddress?.emailAddress]);

  const refreshNotifications = useCallback(async () => {
    if (process.env.EXPO_OS !== "ios") {
      setNotificationStatus("unsupported");
      return;
    }
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification permission refresh" });
      setNotificationStatus("disabled");
      return;
    }
    setNotificationStatus(result.value.granted ? "enabled" : "disabled");
  }, []);

  useEffect(() => {
    void refreshNotifications();
  }, [refreshNotifications]);

  useEffect(() => {
    if (!isLoaded) {
      setLiveActivityStatus("checking");
      return;
    }
    if (!isSignedIn) {
      setLiveActivityStatus("signed-out");
      return;
    }
    if (!AsyncResult.isSuccess(preferencesResult)) {
      if (AsyncResult.isFailure(preferencesResult)) {
        reportAtomCommandResult(preferencesResult, { label: "live activity preference load" });
        setLiveActivityStatus("enabled");
      } else {
        setLiveActivityStatus("checking");
      }
      return;
    }
    setLiveActivityStatus(
      preferencesResult.value.liveActivitiesEnabled === false ? "disabled" : "enabled",
    );
  }, [isLoaded, isSignedIn, preferencesResult]);

  const requestNotifications = useCallback(async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((permission) =>
            permission.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Notifications unavailable",
          error instanceof Error ? error.message : "Could not request notification permission.",
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      // Permission alone is not enough: the switch stays off until the relay
      // registration succeeds, so tell the user the truth about which happened.
      if (getAgentAwarenessRegistrationStatus() === "registered") {
        Alert.alert(
          "Notifications enabled",
          "Live Activity notifications are enabled for this device.",
        );
      } else {
        Alert.alert(
          "Couldn't finish enabling notifications",
          "Notification access was granted, but this device could not be registered with T3 Connect. Notifications will start once registration succeeds.",
        );
      }
      return;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Alert.alert(
        "Notifications unavailable",
        "Live Activity notifications are only available on iOS.",
      );
      return;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Alert.alert("Notifications disabled", "Notifications were not enabled.");
      return;
    }
    Alert.alert(
      "Notifications disabled",
      "Notifications were denied for this app. Open Settings to enable them.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  }, []);

  const promptSignIn = useCallback(() => {
    Alert.alert(
      "Sign in to T3 Connect",
      "Live Activity updates require T3 Connect so relay can deliver updates to this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          onPress: () => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" }),
        },
      ],
    );
  }, [navigation]);

  const linkEnvironments = useCallback(async () => {
    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    setLiveActivityStatus("linking");
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    if (tokenResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      const error = squashAtomCommandFailure(tokenResult);
      Alert.alert(
        "Live Activities unavailable",
        error instanceof Error ? error.message : "Could not enable Live Activity updates.",
      );
      return;
    }
    if (!tokenResult.value) {
      promptSignIn();
      setLiveActivityStatus("signed-out");
      return;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          enabled: true,
          previousEnabled: liveActivitiesPreferenceEnabled,
          clerkToken: tokenResult.value,
          connections,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      if (!isAtomCommandInterrupted(updateResult)) {
        const error = squashAtomCommandFailure(updateResult);
        Alert.alert(
          "Live Activities unavailable",
          error instanceof Error ? error.message : "Could not enable Live Activity updates.",
        );
      }
      return;
    }

    savePreferences({ liveActivitiesEnabled: true });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("enabled");
    // The environment link can succeed while this device's own registration
    // (the push-to-start token the relay needs) has not — don't claim Live
    // Activities are live until the device is actually registered.
    if (getAgentAwarenessRegistrationStatus() === "registered") {
      Alert.alert(
        "Live Activities enabled",
        environmentCount > 0
          ? `${environmentCount} environment${environmentCount === 1 ? "" : "s"} linked for Live Activity updates.`
          : "Live Activity updates are enabled. Add an environment to start receiving updates.",
      );
    } else {
      Alert.alert(
        "Couldn't finish enabling Live Activities",
        "This device could not be registered with T3 Connect, so Live Activities won't appear yet. They'll start once registration succeeds.",
      );
    }
  }, [
    connections,
    environmentCount,
    getToken,
    isSignedIn,
    liveActivitiesPreferenceEnabled,
    promptSignIn,
    savePreferences,
  ]);

  const handleDeviceNotificationsChange = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        void requestNotifications();
        return;
      }

      Alert.alert(
        "Disable notifications",
        "Notification permission is controlled by iOS. Open Settings to disable notifications for T3 Code.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ],
      );
    },
    [requestNotifications],
  );

  const handleLiveActivitiesChange = useCallback(
    (enabled: boolean) => {
      if (!enabled) {
        setLiveActivityStatus("disabled");
        void (async () => {
          let token: string | null = null;
          if (isSignedIn) {
            const tokenResult = await settlePromise(() =>
              getToken(resolveRelayClerkTokenOptions()),
            );
            if (tokenResult._tag === "Failure") {
              reportAtomCommandResult(tokenResult, {
                label: "live activity disable token lookup",
              });
              return;
            }
            token = tokenResult.value;
          }

          const updateResult = await settleAsyncResult(() =>
            runtime.runPromiseExit(
              setLiveActivityUpdatesEnabled({
                enabled: false,
                previousEnabled: liveActivitiesPreferenceEnabled,
                clerkToken: token,
                connections,
              }),
            ),
          );
          if (updateResult._tag === "Failure") {
            setLiveActivityStatus("enabled");
            reportAtomCommandResult(updateResult, {
              label: "live activity disable",
            });
            return;
          }
          savePreferences({ liveActivitiesEnabled: false });
          refreshManagedRelayEnvironments();
        })();
        return;
      }

      if (!isSignedIn) {
        promptSignIn();
        return;
      }

      void linkEnvironments();
    },
    [
      connections,
      getToken,
      isSignedIn,
      linkEnvironments,
      liveActivitiesPreferenceEnabled,
      promptSignIn,
      savePreferences,
    ],
  );

  const openAccount = useCallback(() => {
    if (!isLoaded) return;
    navigation.navigate("SettingsSheet", { screen: "SettingsAuth" });
  }, [isLoaded, navigation]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <View className="gap-3">
          <SettingsSection title="Account">
            <SettingsRow
              icon="person.crop.circle"
              label="T3 Account"
              value={accountLabel}
              onPress={openAccount}
            />
          </SettingsSection>
          <Text className="px-2 text-sm text-foreground-muted">
            T3 Code works locally without signing in. Cloud features are optional.
          </Text>
        </View>

        <SettingsSection title="Configuration">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
            target="SettingsEnvironments"
          />
          <SettingsSwitchRow
            icon="bell.badge"
            label="Device Notifications"
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              notificationStatus === "checking" ||
              notificationStatus === "unsupported"
            }
            subtitle={agentAwarenessPlatform.subtitle}
            // Only reads as on when this device is actually registered with the
            // relay; otherwise notifications cannot be delivered regardless of
            // the local iOS permission.
            value={
              agentAwarenessPushAvailable && notificationStatus === "enabled" && deviceRegistered
            }
            onValueChange={handleDeviceNotificationsChange}
          />
          <SettingsSwitchRow
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              !isLoaded ||
              liveActivityStatus === "checking" ||
              liveActivityStatus === "linking"
            }
            icon="bolt.circle"
            label="Live Activity Updates"
            subtitle={agentAwarenessPlatform.subtitle}
            // Same gate: a saved preference is meaningless until the device
            // registration the relay needs to push updates has succeeded.
            value={
              agentAwarenessPushAvailable &&
              (liveActivityStatus === "enabled" || liveActivityStatus === "linking") &&
              deviceRegistered
            }
            onValueChange={handleLiveActivitiesChange}
          />
        </SettingsSection>

        <GeneralSettingsSection />

        <SettingsSection title="Appearance">
          <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
        </SettingsSection>

        <LegacySettingsSection />

        <ArchivedThreadsSettingsSection />

        <AppSettingsSection />
      </ScrollView>
    </View>
  );
}

function GeneralSettingsSection() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const hydrated = AsyncResult.isSuccess(preferencesResult);
  const steerGraceWindowMs = useSteerGraceWindowMs();
  const archivedSectionVisibleCount = useArchivedSectionVisibleCount();
  const alwaysShowPinnedInAttention = useAlwaysShowPinnedInAttention();
  const sortActiveByLatestUserMessage = useSortActiveByLatestUserMessage();
  const threadListV2Enabled = useThreadListV2Enabled();
  const olderSection = useOlderSectionSettings();

  return (
    <SettingsSection title="General">
      <SettingsRow icon="folder" label="Project Grouping" target="SettingsProjectGrouping" />
      <AutoSettleSettingsRows />
      <SettingsRow icon="chart.bar.xaxis" label="Usage" target="SettingsUsage" />
      <SettingsSliderRow
        description="How long a steered message can still be edited or recalled before it is sent to the running agent. 0.0s sends it immediately."
        disabled={!hydrated}
        icon="bolt.circle"
        label="Steer grace window"
        max={MAX_STEER_GRACE_WINDOW_MS}
        min={MIN_STEER_GRACE_WINDOW_MS}
        onChange={(value) =>
          savePreferences({ steerGraceWindowMs: toStoredSteerGraceWindowMs(value) })
        }
        step={STEER_GRACE_WINDOW_STEP_MS}
        value={steerGraceWindowMs}
        valueLabel={formatSteerGraceWindowSeconds(steerGraceWindowMs)}
      />
      {threadListV2Enabled ? (
        <>
          <SettingsSwitchRow
            disabled={!hydrated}
            icon="pin"
            label="Always show pinned when filtering by attention"
            value={alwaysShowPinnedInAttention}
            onValueChange={(value) =>
              savePreferences({ sidebarAlwaysShowPinnedInAttention: value })
            }
          />
          <SettingsSwitchRow
            disabled={!hydrated}
            icon="arrow.up.to.line"
            label="Move messaged threads to top"
            value={sortActiveByLatestUserMessage}
            onValueChange={(value) =>
              savePreferences({ sidebarV2SortActiveByLatestUserMessage: value })
            }
          />
          <SettingsSwitchRow
            disabled={!hydrated}
            icon="line.3.horizontal.decrease"
            label="Older section"
            subtitle="Fold threads that have gone quiet into their own section. They stay active — nothing is settled, snoozed, or archived — and any activity brings them straight back."
            value={olderSection.enabled}
            onValueChange={(value) => savePreferences({ sidebarOlderSectionEnabled: value })}
          />
          {olderSection.enabled ? (
            <>
              <SettingsSliderRow
                description="How long a thread must go without activity before it moves to Older."
                disabled={!hydrated}
                icon="clock"
                label="Older after"
                max={OLDER_SECTION_AFTER_DAY_STOPS.length - 1}
                min={0}
                onChange={(value) =>
                  savePreferences({
                    sidebarOlderSectionAfterDays: olderSectionAfterDaysAtStop(value),
                  })
                }
                step={1}
                value={olderSectionAfterDaysStopIndex(olderSection.afterDays)}
                valueLabel={formatOlderSectionAfterDays(olderSection.afterDays)}
              />
              <SettingsSwitchRow
                disabled={!hydrated}
                icon="chevron.down"
                label="Start Older folded"
                subtitle="Once you fold or unfold the section yourself, that choice wins for as long as the thread list stays open."
                value={olderSection.collapsedByDefault}
                onValueChange={(value) =>
                  savePreferences({ sidebarOlderSectionCollapsedByDefault: value })
                }
              />
            </>
          ) : null}
          <SettingsSliderRow
            description="How many recently archived threads appear at the end of the thread list."
            disabled={!hydrated}
            icon="archivebox"
            label="Recent archived threads"
            max={MAX_ARCHIVED_SECTION_VISIBLE_COUNT}
            min={MIN_ARCHIVED_SECTION_VISIBLE_COUNT}
            onChange={(value) =>
              savePreferences({
                archivedSectionVisibleCount: toStoredArchivedSectionVisibleCount(value),
              })
            }
            step={1}
            value={archivedSectionVisibleCount}
            valueLabel={`${archivedSectionVisibleCount}`}
          />
        </>
      ) : null}
      <ThreadSyncRow />
    </SettingsSection>
  );
}

function formatLastSyncedLabel(lastRunAt: number | null, now: number): string {
  if (lastRunAt === null) return "Not synced yet";
  const elapsedMs = Math.max(0, now - lastRunAt);
  if (elapsedMs < 60_000) return "Synced just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${new Date(lastRunAt).toLocaleDateString()}`;
}

function useMinuteClockMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}

/**
 * Manual counterpart of the automatic thread prewarming: fires the same
 * engine on demand (bypassing its cooldown) and shows when any environment
 * last completed a full sweep, excluding targeted settle runs. The engine
 * debounces briefly before running, so
 * the row tracks a separate manual-completion cursor until that request reaches
 * a terminal outcome without treating unavailable attempts as successful syncs.
 */
const THREAD_SYNC_PENDING_TIMEOUT_MS = 45_000;

function ThreadSyncRow() {
  const summary = useThreadPrewarmSummary();
  const fireTrigger = useAtomCommand(threadPrewarmTriggerCommand);
  const nowMs = useMinuteClockMs();
  const syncInFlight = useRef(false);
  const [requestedFrom, setRequestedFrom] = useState<
    ThreadPrewarmSummary["environmentLastManualRequestCompletedAt"] | null
  >(null);

  // Manual requests are tracked separately from the engine's own in-flight
  // flag: the engine debounces before it starts, so only the request cursor
  // covers the gap between the tap and the run.
  const manualSyncing =
    requestedFrom !== null &&
    !didEnvironmentPrewarmRunsAdvance(
      summary.environmentLastManualRequestCompletedAt,
      requestedFrom,
    );
  const syncing = manualSyncing || summary.syncing;

  useEffect(() => {
    if (requestedFrom === null) return;
    if (!manualSyncing) {
      syncInFlight.current = false;
      setRequestedFrom(null);
      return;
    }
    const timer = setTimeout(() => {
      syncInFlight.current = false;
      setRequestedFrom(null);
    }, THREAD_SYNC_PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [manualSyncing, requestedFrom]);

  const statusLabel = syncing ? "Syncing…" : formatLastSyncedLabel(summary.lastRunAt, nowMs);

  return (
    <Pressable
      accessibilityLabel="Sync threads now"
      accessibilityRole="button"
      // Only a manual request blocks the action. A background run reports
      // itself in the label, but making "sync now" untappable for the
      // duration would strand anyone who opened Settings to force a sweep.
      accessibilityState={{ busy: syncing, disabled: manualSyncing }}
      accessibilityValue={{ text: statusLabel }}
      disabled={manualSyncing}
      onPress={() => {
        if (syncInFlight.current) return;
        syncInFlight.current = true;
        setRequestedFrom(new Map(summary.environmentLastManualRequestCompletedAt));
        void fireTrigger({ reason: "manual" });
      }}
    >
      <View className="flex-row items-center gap-4 p-4">
        <SymbolView
          name="arrow.triangle.2.circlepath"
          size={22}
          tintColorClassName={"accent-icon"}
          type="monochrome"
          weight="regular"
        />
        <Text className="flex-1 text-lg text-foreground">Sync Threads</Text>
        <Text className="text-base text-foreground-muted">{statusLabel}</Text>
        <View className="w-[22px] items-center">
          {syncing ? <ActivityIndicator colorClassName={"accent-icon"} size="small" /> : null}
        </View>
      </View>
    </Pressable>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

/**
 * Auto-settlement is a user preference that every server has to hold. Mobile
 * has no primary environment, so the first eligible sync target provides the
 * reference value. Edits fan out to every eligible target, and a mismatch row
 * lets the user push the reference out.
 */
function AutoSettleSettingsRows() {
  const { environments } = useEnvironments();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });

  const syncTargets = environments.filter(supportsSharedSettingsSync);
  const reference = syncTargets[0] ?? null;
  const referenceSettings = reference?.serverConfig?.settings ?? null;
  const [daysDraft, setDaysDraft] = useState<string | null>(null);

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (patch: ServerSettingsPatch) => {
    for (const environment of syncTargets) {
      void updateSettings({ environmentId: environment.environmentId, input: { patch } });
    }
  };

  const mismatches = findSharedSettingsMismatches({
    primaryEnvironmentId: reference.environmentId,
    primarySettings: referenceSettings,
    primaryCapabilities: reference.serverConfig?.environment.capabilities,
    environments: environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      syncEligible: supportsSharedSettingsSync(environment),
      settings: environment.serverConfig?.settings ?? null,
      capabilities: environment.serverConfig?.environment.capabilities,
    })),
  });

  const enabled = referenceSettings.threadAutoSettleEnabled;
  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;
  const commitDays = () => {
    const draft = (daysDraft ?? "").trim();
    setDaysDraft(null);
    // Whole-string check so "3.5" and "3days" are rejected instead of
    // silently becoming 3 on every eligible sync target.
    const parsed = /^\d+$/.test(draft) ? Number(draft) : Number.NaN;
    if (
      Number.isInteger(parsed) &&
      parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
      parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
      parsed !== afterDays
    ) {
      writeToAll({ sidebarAutoSettleAfterDays: parsed });
    }
  };

  return (
    <>
      <SettingsSwitchRow
        icon="checkmark.circle"
        label="Settle threads automatically"
        subtitle="Settle threads after inactivity or when their pull request is merged or closed. Settling by hand still works when this is off."
        value={enabled}
        onValueChange={(value) => writeToAll({ threadAutoSettleEnabled: value })}
      />
      {enabled ? (
        <>
          <SettingsSwitchRow
            icon="arrow.triangle.branch"
            label="Auto-settle merged threads"
            value={referenceSettings.sidebarAutoSettleOnMerge}
            onValueChange={(value) => writeToAll({ sidebarAutoSettleOnMerge: value })}
          />
          <SettingsSwitchRow
            icon="clock"
            label="Auto-settle inactive threads"
            subtitle={afterDays === null ? undefined : `After ${afterDays} days without activity`}
            value={afterDays !== null}
            onValueChange={(value) =>
              writeToAll({ sidebarAutoSettleAfterDays: value ? AUTO_SETTLE_DEFAULT_DAYS : null })
            }
          />
          {afterDays !== null ? (
            <View className="flex-row items-center gap-4 border-t border-border-subtle p-4">
              <Text className="flex-1 text-lg text-foreground">Days before auto-settle</Text>
              <TextInput
                className="min-h-10 w-20 rounded-xl px-3 py-2 text-center text-base"
                keyboardType="number-pad"
                returnKeyType="done"
                value={daysDraft ?? String(afterDays)}
                onChangeText={setDaysDraft}
                onBlur={commitDays}
                onSubmitEditing={commitDays}
                accessibilityLabel="Days before auto-settle"
              />
            </View>
          ) : null}
        </>
      ) : null}
      {mismatches.length > 0 ? (
        <View className="flex-row items-center gap-4 border-t border-border-subtle p-4">
          <View className="min-w-0 flex-1">
            <Text className="text-lg text-foreground">Settings differ</Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              const patch = pickSharedServerSettings(
                referenceSettings,
                reference.serverConfig?.environment.capabilities,
              );
              for (const mismatch of mismatches) {
                const target = environments.find(
                  (candidate) => candidate.environmentId === mismatch.environmentId,
                );
                void updateSettings({
                  environmentId: mismatch.environmentId,
                  input: {
                    patch: filterSharedServerPatch(
                      patch,
                      target?.serverConfig?.environment.capabilities,
                    ),
                  },
                });
              }
            }}
            className="rounded-full bg-subtle px-4 py-2 active:opacity-70"
          >
            <Text className="text-base font-t3-medium text-foreground">Apply to all</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

/**
 * Device-local legacy toggles. Mobile has no client-settings sync, so this is
 * the counterpart of web's Settings → General → Legacy features backed by
 * mobile preferences.
 */
function LegacySettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const threadListV2Enabled = useThreadListV2Enabled();
  const planModeEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.planModeEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Legacy">
        <SettingsSwitchRow
          icon="sidebar.left"
          label="Legacy Thread List"
          value={!threadListV2Enabled}
          onValueChange={(value) => savePreferences({ legacyThreadListEnabled: value })}
        />
        <SettingsSwitchRow
          icon="hammer"
          label="Plan Mode"
          value={planModeEnabled}
          onValueChange={(value) => savePreferences({ planModeEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Opt into retired interfaces kept for compatibility. Plan Mode restores the Build/Plan
        control; otherwise every task runs in Build mode.
      </Text>
    </View>
  );
}

function AppSettingsSection() {
  const [updateState, setUpdateState] = useState<AppUpdateCheckState>("idle");
  const updateInFlight = useRef(false);
  const hiddenUpdateTapCount = useRef(0);

  const version = Constants.expoConfig?.version ?? "0.0.0";
  // Fall back to "production" to match resolveAppVariant in app.config.ts, so a
  // missing variant never mislabels a production build as development.
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  const versionLabel = variantLabel ? `${version} · ${variantLabel}` : version;
  const updateCheckAvailable = isAppUpdateCheckAvailable();
  const busy =
    updateState === "checking" || updateState === "downloading" || updateState === "restarting";

  // "Up to date" is a transient acknowledgement, not a state worth persisting —
  // return the version row to its normal, deliberately quiet state.
  useEffect(() => {
    if (updateState !== "current") return;
    const timer = setTimeout(() => setUpdateState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [updateState]);

  const checkForUpdate = useCallback(async () => {
    // `disabled={busy}` only takes effect on the next render, so two taps in the
    // same frame would both get through. The ref closes that window.
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    try {
      // The user asked for this restart by tapping the version row, so it may
      // apply immediately instead of prompting.
      await runAppUpdateCheck({
        applyMode: "immediate",
        onFailure: (message) => Alert.alert("Update failed", message),
        onStateChange: setUpdateState,
      });
    } finally {
      updateInFlight.current = false;
    }
  }, []);

  const handleVersionPress = useCallback(() => {
    if (!updateCheckAvailable || updateInFlight.current) return;
    const tap = registerHiddenUpdateTap(hiddenUpdateTapCount.current);
    hiddenUpdateTapCount.current = tap.nextCount;
    if (tap.shouldCheck) {
      void checkForUpdate();
    }
  }, [checkForUpdate, updateCheckAvailable]);

  const statusLabel =
    updateState === "checking"
      ? "Checking…"
      : updateState === "downloading"
        ? "Downloading…"
        : // "ready" appears only when this check joined an in-flight background-mode
          // check; that download installs at the next backgrounding.
          updateState === "ready"
          ? "Update ready"
          : updateState === "restarting"
            ? "Restarting…"
            : updateState === "current"
              ? "Up to date"
              : null;

  const versionRow = (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="info.circle"
        size={22}
        tintColorClassName={"accent-icon"}
        type="monochrome"
        weight="regular"
      />
      <Text className="flex-1 text-lg text-foreground">Version</Text>
      <View className="items-end">
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
        {statusLabel ? (
          <Text className="text-xs text-foreground-muted/70">{statusLabel}</Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <SettingsSection title="App">
      <SettingsRow icon="internaldrive" label="Client Storage" target="SettingsClientStorage" />
      <SettingsRow icon="doc.text" label="Legal" fullScreenTarget="SettingsLegal" />
      {updateCheckAvailable ? (
        <Pressable
          accessibilityLabel={`Version ${versionLabel}`}
          accessibilityRole="text"
          disabled={busy}
          onPress={handleVersionPress}
        >
          {versionRow}
        </Pressable>
      ) : (
        versionRow
      )}
    </SettingsSection>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function ArchivedThreadsSettingsSection() {
  return (
    <SettingsSection title="Threads">
      <SettingsRow icon="archivebox" label="Archived Threads" target="SettingsArchive" />
    </SettingsSection>
  );
}
