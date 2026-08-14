import type {
  ProviderUsageStatus,
  ProviderUsageWindow,
} from "@t3tools/client-runtime/state/provider-usage";
import {
  describeProviderUsageWindowValue,
  formatProviderUsageAge,
  formatProviderUsageResetTime,
  isProviderUsageSnapshotStale,
  providerUsageBarPercent,
} from "@t3tools/client-runtime/state/provider-usage-presentation";

import { useCallback, useEffect, useRef } from "react";
import { Modal, Platform, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ProviderUsageSheetAccount } from "../../lib/providerUsagePill";
import { useThemeColor } from "../../lib/useThemeColor";

/**
 * Full provider quota for every configured account, as a bottom sheet.
 *
 * This used to be a native context menu, which could only offer one truncated
 * subtitle per account: everything after the first window was cut off and a
 * menu cannot draw a bar at all. Usage is read, not acted on, so it belongs in
 * a scrollable surface that shows each window's percentage, bar, and reset the
 * same way the desktop meter does.
 */

const STATUS_BAR_CLASS: Record<ProviderUsageStatus, string> = {
  ok: "bg-neutral-400 dark:bg-neutral-500",
  warning: "bg-amber-500",
  critical: "bg-rose-500",
};

const STATUS_TEXT_CLASS: Record<ProviderUsageStatus, string> = {
  ok: "text-foreground-muted",
  warning: "text-amber-600 dark:text-amber-400",
  critical: "text-rose-600 dark:text-rose-400",
};

function UsageWindowRow(props: { readonly window: ProviderUsageWindow; readonly nowMs: number }) {
  const { window, nowMs } = props;
  const resetTime = formatProviderUsageResetTime(window.resetsAt, nowMs);
  const percent = providerUsageBarPercent(window);
  return (
    <View className="gap-1.5">
      <View className="flex-row items-baseline gap-2">
        <Text className="shrink text-xs font-t3-medium text-foreground" numberOfLines={1}>
          {window.label}
        </Text>
        <View className="flex-1" />
        <Text
          className={cn("text-xs font-t3-medium tabular-nums", STATUS_TEXT_CLASS[window.status])}
        >
          {describeProviderUsageWindowValue(window)}
        </Text>
      </View>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`${window.label} usage`}
        accessibilityValue={
          window.usedPercent !== null
            ? { min: 0, max: 100, now: Math.round(window.usedPercent) }
            : undefined
        }
        className="h-1 overflow-hidden rounded-full bg-subtle-strong"
      >
        <View
          className={cn("h-full rounded-full", STATUS_BAR_CLASS[window.status])}
          style={{ width: `${percent}%` }}
        />
      </View>
      {resetTime ? (
        <Text className="text-2xs text-foreground-tertiary tabular-nums">resets {resetTime}</Text>
      ) : null}
    </View>
  );
}

function AccountCard(props: {
  readonly account: ProviderUsageSheetAccount;
  readonly showCurrentBadge: boolean;
  readonly nowMs: number;
  readonly unavailable: boolean;
}) {
  const { account, nowMs } = props;
  const stale = isProviderUsageSnapshotStale(account.observedAt, nowMs);
  return (
    <View
      className={cn(
        "gap-2.5 rounded-2xl border border-border bg-card px-4 py-3.5",
        stale && "opacity-60",
      )}
    >
      <View className="gap-0.5">
        {/* Name, email, and metadata share one line: a pooled gateway lists
            many accounts, and three header lines each outgrew the sheet. */}
        <View className="flex-row items-center gap-1.5">
          {/* A pooled account's name is short ("Claude"), but a direct
              instance's is a user-chosen string that would otherwise squeeze
              out everything after it. */}
          <Text className="shrink text-sm font-t3-bold text-foreground" numberOfLines={1}>
            {account.displayName}
          </Text>
          {account.email ? (
            <Text className="shrink text-2xs text-foreground-muted" numberOfLines={1}>
              {account.email}
            </Text>
          ) : null}
          {account.detail ? (
            <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
              · {account.detail}
            </Text>
          ) : null}
          {props.showCurrentBadge && account.isCurrent ? (
            <View className="rounded-md bg-subtle-strong px-1.5 py-0.5">
              <Text className="text-3xs font-t3-bold uppercase text-foreground-muted">Current</Text>
            </View>
          ) : null}
        </View>
        {account.error ? (
          <Text className="text-2xs text-rose-600 dark:text-rose-400">{account.error}</Text>
        ) : null}
        {/* A lagging account states its own age; the header covers the rest. */}
        {stale ? (
          <Text className="text-2xs text-foreground-tertiary">
            {formatProviderUsageAge(account.observedAt, nowMs)}
          </Text>
        ) : null}
      </View>
      {account.snapshot && account.snapshot.windows.length > 0 ? (
        account.snapshot.windows.map((window) => (
          <UsageWindowRow key={window.id} window={window} nowMs={nowMs} />
        ))
      ) : (
        <Text className="text-xs text-foreground-muted">
          {props.unavailable ? "Couldn't load usage" : "No usage data yet"}
        </Text>
      )}
    </View>
  );
}

export function ProviderUsageSheet(props: {
  readonly visible: boolean;
  /**
   * Nothing here is configured, so every exit is "done": the host restores
   * whatever typing session the pill interrupted rather than treating a
   * backdrop tap as a reason to leave the keyboard down.
   */
  readonly onClose: () => void;
  readonly onDismissed: () => void;
  /** Driver-derived label ("Claude", "Codex") for the sheet title. */
  readonly providerLabel: string;
  readonly accounts: ReadonlyArray<ProviderUsageSheetAccount>;
  readonly fableUsage: {
    readonly accountName: string;
    readonly window: ProviderUsageWindow;
  } | null;
  readonly nowMs: number;
  /** Age of the panel as a whole — its oldest account read. */
  readonly panelObservedAt: number | null;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  /** The read itself failed, as opposed to succeeding with nothing to show. */
  readonly unavailable?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const iconMuted = useThemeColor("--color-icon-muted");
  // Dismissal bookkeeping mirrors ThreadSettingsSheet: RN only emits
  // Modal.onDismiss on iOS, and a host can unmount a presented sheet outright.
  // The presentation hook's transition table makes duplicate reports no-ops.
  const wasPresentedRef = useRef(false);
  const notifyDismissed = useCallback(() => {
    if (!wasPresentedRef.current) {
      return;
    }
    wasPresentedRef.current = false;
    props.onDismissed();
  }, [props.onDismissed]);
  useEffect(() => {
    if (props.visible) {
      wasPresentedRef.current = true;
    } else if (Platform.OS === "android" && wasPresentedRef.current) {
      notifyDismissed();
    }
  }, [notifyDismissed, props.visible]);
  const onDismissedRef = useRef(props.onDismissed);
  useEffect(() => {
    onDismissedRef.current = props.onDismissed;
  }, [props.onDismissed]);
  useEffect(
    () => () => {
      onDismissedRef.current();
    },
    [],
  );

  const title = `${props.providerLabel} usage`;
  const showCurrentBadge = props.accounts.length > 1;
  const fableResetTime = props.fableUsage
    ? formatProviderUsageResetTime(props.fableUsage.window.resetsAt, props.nowMs)
    : null;

  return (
    <Modal
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType={Platform.OS === "ios" ? "fade" : "none"}
      visible={props.visible}
      onDismiss={notifyDismissed}
      onRequestClose={() => props.onClose()}
    >
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel={`Close ${title}`}
          className="absolute inset-0 bg-backdrop"
          onPress={() => props.onClose()}
        />
        <View
          className="overflow-hidden rounded-t-[24px] border border-b-0 border-border bg-sheet"
          style={{ maxHeight: windowHeight * 0.85 }}
        >
          {/* The grabber doubles as the accessible close control: the backdrop
              above a tall sheet is a sliver VoiceOver can't reach. */}
          <Pressable
            accessibilityLabel={`Close ${title}`}
            accessibilityRole="button"
            onPress={() => props.onClose()}
            className="items-center pb-1 pt-2.5"
          >
            <View className="h-1 w-9 rounded-full bg-subtle-strong" />
          </Pressable>
          <View className="flex-row items-center gap-2 px-5 pb-2 pt-1.5">
            <Text className="text-base font-t3-bold text-foreground">{title}</Text>
            <View className="flex-1" />
            {/* One freshness line for the whole read; stale accounts add theirs. */}
            <Text className="text-2xs text-foreground-tertiary tabular-nums">
              {props.refreshing
                ? "updating…"
                : formatProviderUsageAge(props.panelObservedAt, props.nowMs)}
            </Text>
            <Pressable
              accessibilityLabel="Refresh usage"
              accessibilityRole="button"
              accessibilityState={{ disabled: props.refreshing }}
              disabled={props.refreshing}
              hitSlop={8}
              onPress={props.onRefresh}
              className={cn("p-1 active:opacity-70", props.refreshing && "opacity-40")}
            >
              <SymbolView
                name="arrow.clockwise"
                size={15}
                tintColor={iconMuted}
                type="monochrome"
              />
            </Pressable>
          </View>
          {props.fableUsage ? (
            <View className="flex-row items-center gap-2 px-5 pb-2">
              <Text className="text-2xs font-t3-medium text-foreground-muted">Fable next</Text>
              <Text className="shrink text-2xs text-foreground-muted" numberOfLines={1}>
                {props.fableUsage.accountName}
              </Text>
              <View className="flex-1" />
              <Text
                className={cn(
                  "text-2xs font-t3-medium tabular-nums",
                  STATUS_TEXT_CLASS[props.fableUsage.window.status],
                )}
              >
                {describeProviderUsageWindowValue(props.fableUsage.window)}
                {fableResetTime ? (
                  <Text className="text-foreground-tertiary"> · resets {fableResetTime}</Text>
                ) : null}
              </Text>
            </View>
          ) : null}
          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerStyle={{
              gap: 10,
              paddingBottom: insets.bottom + 16,
              paddingHorizontal: 16,
              paddingTop: 4,
            }}
            showsVerticalScrollIndicator={false}
          >
            {props.accounts.map((account) => (
              <AccountCard
                key={account.accountKey ?? account.instanceId}
                account={account}
                showCurrentBadge={showCurrentBadge}
                nowMs={props.nowMs}
                unavailable={props.unavailable === true}
              />
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
