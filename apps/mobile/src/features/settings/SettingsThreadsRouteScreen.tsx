import { AutoSettleDaysField } from "./components/AutoSettleDaysField";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import {
  MAX_ARCHIVED_SECTION_VISIBLE_COUNT,
  MAX_STEER_GRACE_WINDOW_MS,
  MIN_ARCHIVED_SECTION_VISIBLE_COUNT,
  MIN_STEER_GRACE_WINDOW_MS,
} from "@t3tools/contracts/settings";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { AppText as Text } from "../../components/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  didEnvironmentPrewarmRunsAdvance,
  threadPrewarmTriggerCommand,
  type ThreadPrewarmSummary,
  useThreadPrewarmSummary,
} from "../../state/prewarm";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  useArchivedSectionVisibleCount,
  useSteerGraceWindowMs,
} from "../../state/use-mobile-preferences";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { SettingsSliderRow } from "./components/SettingsSliderRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { planAutoSettleSettingsSync, type AutoSettleSettings } from "./autoSettleSettingsSync";
import {
  formatSteerGraceWindowSeconds,
  STEER_GRACE_WINDOW_STEP_MS,
  toStoredArchivedSectionVisibleCount,
  toStoredSteerGraceWindowMs,
} from "./lib/extras-settings";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

export function SettingsThreadsRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Thread behavior" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <AutoSettleSettingsRows />
          <DeviceThreadSettingsSection />
          <LegacySettingsSection />
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

/**
 * Mobile edits auto-settle defaults across selected capable targets.
 */
function AutoSettleSettingsRows() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const projectSelected = selectedProjectKey !== null;
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });

  const syncEnvironments = selectedTargets.filter(supportsSharedSettingsSync);
  const syncTargets = resolveMobileSettingsTargets(
    syncEnvironments,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const displayTargets =
    pendingWrites > 0 && pendingTargets !== null ? pendingTargets : syncTargets;
  const reference = displayTargets[0] ?? null;
  const referenceSettings = reference?.settings ?? null;

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (
    patch: Partial<AutoSettleSettings> & {
      autoResumeLimitedThreads?: boolean;
      snoozeLimitedThreads?: boolean;
    },
  ) => {
    if (writeInFlight.current) return;
    const writes = planMobileScopedSettingsPatch(syncTargets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(syncTargets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };

  const { patch: autoSettlePatch, mismatches } = planAutoSettleSettingsSync(
    {
      environmentId: reference.environment.environmentId,
      projectId: reference.projectId,
      settings: referenceSettings,
    },
    displayTargets.map((target) => ({
      environmentId: target.environment.environmentId,
      projectId: target.projectId,
      label: target.environment.label,
      settings: target.settings,
    })),
  );

  const supportsProjectOverrides = syncTargets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides === true,
  );
  const disabled = pendingWrites > 0 || (projectSelected && !supportsProjectOverrides);
  const hasProjectOverrides =
    projectSelected &&
    syncTargets.some(
      (target) =>
        target.sources.sidebarAutoSettleOnMerge === "project" ||
        target.sources.sidebarAutoSettleAfterDays === "project",
    );
  const clearProjectOverrides = () => {
    if (writeInFlight.current) return;
    const writes = planMobileScopedSettingsClear(syncTargets, [
      "sidebarAutoSettleOnMerge",
      "sidebarAutoSettleAfterDays",
    ]);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(syncTargets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };

  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;

  return (
    <View className="gap-6">
      {projectSelected ? (
        <SettingsProjectOverridesSection
          projectLabel={selectedProject?.label ?? "Unavailable project"}
          hasOverrides={hasProjectOverrides}
          supportsOverrides={supportsProjectOverrides}
          pending={pendingWrites > 0}
          onClear={clearProjectOverrides}
        />
      ) : null}
      {!projectSelected ? (
        <SettingsSection title="Usage limits">
          <SettingsSwitchRow
            icon="clock"
            label="Auto-resume limited threads"
            value={uniformMobileSetting(displayTargets, "autoResumeLimitedThreads")}
            disabled={disabled}
            onValueChange={(value) => writeToAll({ autoResumeLimitedThreads: value })}
          />
          <SettingsSwitchRow
            icon="clock"
            label="Snooze limited threads"
            value={uniformMobileSetting(displayTargets, "snoozeLimitedThreads")}
            disabled={disabled}
            onValueChange={(value) => writeToAll({ snoozeLimitedThreads: value })}
          />
        </SettingsSection>
      ) : null}
      <SettingsSection title="Auto-settle">
        <SettingsSwitchRow
          icon="arrow.triangle.branch"
          label="Auto-settle merged threads"
          value={referenceSettings.sidebarAutoSettleOnMerge}
          disabled={disabled}
          onValueChange={(value) => writeToAll({ sidebarAutoSettleOnMerge: value })}
        />
        <SettingsSwitchRow
          icon="clock"
          label="Auto-settle inactive threads"
          value={afterDays !== null}
          disabled={disabled}
          onValueChange={(value) =>
            writeToAll({ sidebarAutoSettleAfterDays: value ? AUTO_SETTLE_DEFAULT_DAYS : null })
          }
        />
        {afterDays !== null ? (
          <View className="flex-row items-center gap-4 px-4 py-4 android:min-h-14 android:py-3">
            <View className="w-[22px] android:w-6" />
            <Text className="flex-1 text-foreground text-lg android:text-base">Inactive days</Text>
            <AutoSettleDaysField
              value={afterDays}
              disabled={disabled}
              onValueChange={(value) => writeToAll({ sidebarAutoSettleAfterDays: value })}
            />
          </View>
        ) : null}
      </SettingsSection>
      {pendingWrites === 0 && mismatches.length > 0 ? (
        <SettingsSection title="Across environments">
          <View className="gap-3 p-4">
            <Text className="text-base text-foreground">Auto-settle defaults differ</Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => writeToAll(autoSettlePatch)}
              className="self-start rounded-full bg-subtle px-4 py-2 active:opacity-70"
            >
              <Text className="text-sm font-t3-medium text-foreground">
                Apply auto-settle defaults
              </Text>
            </Pressable>
          </View>
        </SettingsSection>
      ) : null}
    </View>
  );
}

/**
 * Device-local mirror of the web fork's Extras thread settings, plus the
 * manual counterpart of thread prewarming.
 */
function DeviceThreadSettingsSection() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const hydrated = AsyncResult.isSuccess(preferencesResult);
  const steerGraceWindowMs = useSteerGraceWindowMs();
  const archivedSectionVisibleCount = useArchivedSectionVisibleCount();

  return (
    <SettingsSection title="This device">
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
 * last completed a full sweep. The engine debounces briefly before running,
 * so the row tracks the manual-completion cursor until the request reaches a
 * terminal outcome, without treating unavailable attempts as successful syncs.
 */
const THREAD_SYNC_PENDING_TIMEOUT_MS = 45_000;

function ThreadSyncRow() {
  const summary = useThreadPrewarmSummary();
  const fireTrigger = useAtomCommand(threadPrewarmTriggerCommand);
  const nowMs = useMinuteClockMs();
  const [requestedFrom, setRequestedFrom] = useState<
    ThreadPrewarmSummary["environmentLastManualRequestCompletedAt"] | null
  >(null);

  const manualSyncing =
    requestedFrom !== null &&
    !didEnvironmentPrewarmRunsAdvance(
      summary.environmentLastManualRequestCompletedAt,
      requestedFrom,
    );
  const syncing = manualSyncing || summary.syncing;

  // Stop waiting on a request the engine never completed (e.g. it was torn down).
  useEffect(() => {
    if (!manualSyncing) return;
    const timer = setTimeout(() => setRequestedFrom(null), THREAD_SYNC_PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [manualSyncing]);

  const statusLabel = syncing ? "Syncing…" : formatLastSyncedLabel(summary.lastRunAt, nowMs);

  // Only a manual request blocks the action: a background run reports itself
  // in the label but must not strand someone who opened Settings to force a sweep.
  return (
    <SettingsActionRow
      icon="arrow.triangle.2.circlepath"
      label={`Sync Threads · ${statusLabel}`}
      disabled={manualSyncing}
      loading={syncing}
      onPress={() => {
        // Repeated taps before a re-render collapse into one debounced run.
        if (manualSyncing) return;
        setRequestedFrom(new Map(summary.environmentLastManualRequestCompletedAt));
        void fireTrigger({ reason: "manual" });
      }}
    />
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
  const planModeEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.planModeEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Legacy">
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
