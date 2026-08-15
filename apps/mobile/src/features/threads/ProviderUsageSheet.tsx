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

import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ProviderUsageSheetAccount } from "../../lib/providerUsagePill";
import { useThemeColor } from "../../lib/useThemeColor";

/**
 * Full provider quota for every configured account, as a native form sheet.
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

type ProviderUsageSheetProps = {
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
};

export type ProviderUsageRouteSession = ProviderUsageSheetProps & {
  readonly ownerId: string;
};

type ProviderUsageRouteContextValue = {
  readonly session: ProviderUsageRouteSession | null;
  readonly present: (session: ProviderUsageRouteSession) => void;
  readonly clear: (ownerId: string) => void;
};

const ProviderUsageRouteContext = createContext<ProviderUsageRouteContextValue | null>(null);

/**
 * Whether a presented session would change anything on screen.
 *
 * The composer re-presents on every render while the sheet is open, and this
 * provider sits above the whole navigator — so storing an equal-but-new session
 * re-renders the app for nothing, and a caller whose session object is not
 * memoized would drive that render loop indefinitely. Comparing field by field
 * makes such a caller a no-op instead of a hang.
 */
function isSameProviderUsageRouteSession(
  current: ProviderUsageRouteSession | null,
  next: ProviderUsageRouteSession,
): boolean {
  if (current === null) return false;
  if (current === next) return true;
  const keys = Object.keys(next) as ReadonlyArray<keyof ProviderUsageRouteSession>;
  return (
    keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key])
  );
}

/** Bridges the active thread's quota state into the root native sheet route. */
export function ProviderUsageRouteProvider(props: { readonly children: ReactNode }) {
  const [session, setSession] = useState<ProviderUsageRouteSession | null>(null);
  const present = useCallback((nextSession: ProviderUsageRouteSession) => {
    setSession((current) =>
      isSameProviderUsageRouteSession(current, nextSession) ? current : nextSession,
    );
  }, []);
  const clear = useCallback((ownerId: string) => {
    setSession((current) => (current?.ownerId === ownerId ? null : current));
  }, []);
  const value = useMemo(() => ({ session, present, clear }), [clear, present, session]);

  return (
    <ProviderUsageRouteContext.Provider value={value}>
      {props.children}
    </ProviderUsageRouteContext.Provider>
  );
}

export function useProviderUsageRoutePresentation() {
  const value = use(ProviderUsageRouteContext);
  if (!value) {
    throw new Error(
      "useProviderUsageRoutePresentation must be used inside ProviderUsageRouteProvider.",
    );
  }
  return value;
}

export function ProviderUsageSheet(
  props: ProviderUsageSheetProps & { readonly onClose: () => void },
) {
  const insets = useSafeAreaInsets();
  const iconMuted = useThemeColor("--color-icon-muted");

  const title = `${props.providerLabel} usage`;
  const showCurrentBadge = props.accounts.length > 1;
  const fableResetTime = props.fableUsage
    ? formatProviderUsageResetTime(props.fableUsage.window.resetsAt, props.nowMs)
    : null;

  return (
    // A form sheet whose scrollable content sits beside other chrome is laid
    // out natively, and react-native-screens only recognizes that shape when
    // the sheet's container holds the chrome and the scroll view as two
    // uncollapsed subviews. Flattening either one hands it a flat pile of
    // leaves, and it positions the scroll view over the chrome instead of
    // below it — the header ends up painted behind the first account card.
    <View collapsable={false} className="flex-1 bg-sheet">
      <View collapsable={false}>
        <View className="flex-row items-center gap-2 px-4 pb-2 pt-3">
          <Pressable
            accessibilityLabel={`Close ${title}`}
            accessibilityRole="button"
            hitSlop={8}
            onPress={props.onClose}
            className="p-1 active:opacity-70"
          >
            <SymbolView
              name={Platform.OS === "android" ? "chevron.left" : "xmark"}
              size={16}
              tintColor={iconMuted}
              type="monochrome"
            />
          </Pressable>
          <Text className="text-base font-t3-bold text-foreground">{title}</Text>
          <View className="flex-1" />
          {/* One freshness line for the whole read; stale accounts add theirs. */}
          <Text className="text-2xs text-foreground-tertiary tabular-nums">
            {props.refreshing
              ? "updating…"
              : formatProviderUsageAge(props.panelObservedAt, props.nowMs)}
          </Text>
          {/* The spinner replaces the control it disables, so the refresh state
              reads in the same place the action lives — the desktop meter spins
              this same icon in place. */}
          {props.refreshing ? (
            <View className="p-1">
              <ActivityIndicator accessibilityLabel="Refreshing usage" size="small" />
            </View>
          ) : (
            <Pressable
              accessibilityLabel="Refresh usage"
              accessibilityRole="button"
              hitSlop={8}
              onPress={props.onRefresh}
              className="p-1 active:opacity-70"
            >
              <SymbolView
                name="arrow.clockwise"
                size={15}
                tintColor={iconMuted}
                type="monochrome"
              />
            </Pressable>
          )}
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
      </View>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          gap: 10,
          paddingBottom: insets.bottom + 16,
          paddingHorizontal: 16,
          // Matches the horizontal inset so the first card is framed evenly and
          // the sheet's grabber keeps clear of it.
          paddingTop: 16,
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
  );
}

/** Provider quota hosted by the root native form-sheet route. */
export function ProviderUsageRouteScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const presentation = useProviderUsageRoutePresentation();
  const session = presentation.session;

  useEffect(() => {
    if (!session) {
      navigation.goBack();
    }
  }, [navigation, session]);

  if (!session) {
    return <View className="flex-1 bg-sheet" />;
  }

  const { ownerId: _ownerId, ...usage } = session;
  return <ProviderUsageSheet {...usage} onClose={() => navigation.goBack()} />;
}
