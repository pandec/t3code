import type { MenuAction } from "@react-native-menu/menu";
import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationThreadShell,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
  ServerProviderSkill,
} from "@t3tools/contracts";
import {
  buildThreadTitleComposerText,
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type ViewStyle,
} from "react-native";
import ImageViewing from "react-native-image-viewing";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutDown,
  LinearTransition,
} from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { scopedThreadKey } from "../../lib/scopedEntities";

import { AppText as Text } from "../../components/AppText";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { GlassSurface } from "../../components/GlassSurface";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorSelection,
} from "../../components/ComposerEditor";
import {
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import {
  deriveLatestProviderUsageSnapshot,
  deriveProviderUsageAccountsFromServerSnapshot,
  deriveProviderUsageSnapshotFromServerSnapshot,
  featuredProviderUsageAccount,
  listProviderUsageAccountsForDisplay,
  presentProviderUsageAccount,
  providerUsageLabelForDriver,
  primaryProviderUsageWindow,
  providerUsageRingStatus,
  resolveProviderUsageFableRing,
  resolveProviderUsageModel,
  resolveProviderUsageUpstreamProvider,
  resolveProviderUsageInstanceId,
} from "@t3tools/client-runtime/state/provider-usage";
import { cn } from "../../lib/cn";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import {
  canStartProviderUsageRefresh,
  providerUsageTriggerLabel,
} from "../../lib/providerUsagePill";
import {
  oldestProviderUsageObservedAt,
  resolveProviderUsageBoundAuthIndex,
  shouldProbeProviderUsageThreadAccount,
  shouldRefreshProviderUsageOnOpen,
  type ProviderUsageThreadAccountProbe,
  type ProviderUsageThreadAccountState,
} from "@t3tools/client-runtime/state/provider-usage-presentation";
import { flushComposerDrafts } from "../../state/use-composer-drafts";
import type { SendMessageOptions } from "../../state/use-thread-composer-state";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { RemoteClientConnectionState } from "../../lib/connection";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import {
  providerOptionValueLabels,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { useComposerPathSearch } from "../../state/use-composer-path-search";
import { ComposerCommandPopover, type ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";
import { RUNTIME_MODE_CHOICES } from "./thread-settings-options";
import { threadComposerSendLabel } from "./threadComposerSendLabel";
import {
  type ProviderUsageRouteSession,
  useProviderUsageRoutePresentation,
} from "./ProviderUsageSheet";
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "./ThreadSettingsSheet";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";
import { VoiceRecorderControl } from "./VoiceRecorderControl";

/**
 * Height of the collapsed composer (pill + vertical padding, excluding safe-area inset).
 * Exported so the parent can compute feed overlap / content insets.
 */
export const COMPOSER_COLLAPSED_CHROME = 60;

/**
 * Height of the expanded composer (card + toolbar + vertical padding, excluding safe-area inset).
 * Used by the parent to compute the larger feed bottom inset when the composer is focused.
 */
export const COMPOSER_EXPANDED_CHROME = 156;

/** Long-press menu on the send button while a turn is running. */
const SEND_MENU_ACTIONS: MenuAction[] = [{ id: "queue", title: "Queue for later", image: "clock" }];

function useMinuteClockMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}

export interface ThreadComposerProps {
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  /**
   * Message sync phase for the selected thread (drives the status pill):
   * "loading" = first fetch, nothing to show yet; "syncing" = cached messages
   * are on screen while they reconcile with the server.
   */
  readonly threadSyncPhase?: "loading" | "syncing" | null;
  readonly selectedThread: OrchestrationThreadShell;
  readonly persistedModel: string;
  readonly serverConfig: T3ServerConfig | null;
  readonly queueCount: number;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string | null;
  /**
   * Skills discovered for the thread's own working directory (worktree-aware),
   * resolved by the parent so the `$` menu and the feed's skill chips always
   * agree and only one discovery request is issued per thread.
   */
  readonly providerSkills: ReadonlyArray<ServerProviderSkill>;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onVoiceTranscript: (text: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: (options?: SendMessageOptions) => Promise<MessageId | null>;
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onReconnectEnvironment: () => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
  /** Fires on editor focus/blur; hosts use it to vet stale keyboard state. */
  readonly onEditorFocusChange?: (focused: boolean) => void;
}

/**
 * The pill / card container — renders with Expo's native GlassView on supported
 * iOS 26+ devices and keeps the existing opaque fallback elsewhere.
 * Exported so NewTaskDraftScreen can render the same composer chrome.
 */
// One timing for every piece of the expanded↔compact morph so the surface,
// toolbar, and siblings move together instead of popping between layouts.
// Android gets NO layout transition: the composer rides the keyboard via
// KeyboardStickyView (frame-synced to the IME), and a time-based morph
// running alongside that translate reads as jitter. Snapping the layout and
// letting the keyboard-synced slide be the only motion looks native there.
const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === "android" ? undefined : LinearTransition.duration(220);

export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  readonly isDarkMode: boolean;
  /** Existing thread composers morph between pill and card layouts. */
  readonly animateLayout?: boolean;
}) {
  const cardColor = useThemeColor("--color-card-translucent");
  const borderColor = useThemeColor("--color-border");
  const shadowColor = useThemeColor("--color-primary-shadow");
  // Drop shadow lives on a wrapper: `overflow: "hidden"` on the surface itself
  // (needed to clip content to the pill shape) would clip the shadow on iOS.
  const shadowStyle: ViewStyle = {
    borderRadius: props.style.borderRadius,
    shadowColor,
    shadowOpacity: props.isDarkMode ? 0.35 : 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  };

  return (
    <Animated.View
      layout={props.animateLayout === false ? undefined : COMPOSER_LAYOUT_TRANSITION}
      style={shadowStyle}
    >
      <GlassSurface
        chrome="none"
        fallbackStyle={{
          backgroundColor: cardColor,
          borderWidth: 1,
          borderColor,
        }}
        glassEffectStyle="regular"
        // The composer is a passive material containing interactive controls.
        // Expo GlassView defaults to non-interactive and both layouts share it.
        tintColor="transparent"
        style={props.style}
      >
        {props.children}
      </GlassSurface>
    </Animated.View>
  );
}

type ComposerStatusPillState = {
  readonly kind: "unavailable" | "reconnecting" | "syncing";
  readonly label: string;
};

function composerConnectionStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: RemoteClientConnectionState;
  readonly environmentLabel: string | null;
  readonly threadSyncPhase?: "loading" | "syncing" | null;
}): ComposerStatusPillState | null {
  const environmentLabel = input.environmentLabel ?? "Environment";

  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "reconnecting",
        label:
          input.connectionError === null
            ? `Reconnecting to ${environmentLabel}...`
            : `Failed to connect. Retrying ${environmentLabel}...`,
      };
    case "offline":
      return { kind: "unavailable", label: "You are offline" };
    case "error":
      return {
        kind: "unavailable",
        label: input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      };
    case "available":
      return { kind: "unavailable", label: `${environmentLabel} is not connected` };
    case "connected":
      break;
  }

  // Connected: the pill is the single loading/sync indicator. One stable
  // label per open — "Loading" when starting from scratch, "Syncing" when
  // cached messages are already visible.
  switch (input.threadSyncPhase) {
    case "loading":
      return { kind: "syncing", label: "Loading messages..." };
    case "syncing":
      return { kind: "syncing", label: "Syncing messages..." };
    default:
      return null;
  }
}

const ComposerConnectionStatusPill = memo(function ComposerConnectionStatusPill(props: {
  readonly onPress: () => void;
  readonly status: ComposerStatusPillState;
}) {
  const isReconnecting = props.status.kind !== "unavailable";
  const indicatorColor = useThemeColor("--color-icon-muted");

  return (
    <Animated.View
      className="absolute inset-x-0 bottom-full items-center pb-2"
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(140)}
      pointerEvents="box-none"
    >
      <Pressable
        accessibilityRole="button"
        onPress={props.onPress}
        className="max-w-full flex-row items-center gap-2 rounded-full bg-card px-3 py-2 shadow-sm active:opacity-70"
      >
        {isReconnecting ? (
          <ActivityIndicator size="small" color={indicatorColor} />
        ) : (
          <View className="h-2 w-2 rounded-full bg-red-500" />
        )}
        <Text
          className="max-w-[260px] text-sm font-t3-bold leading-snug text-foreground"
          numberOfLines={1}
        >
          {props.status.label}
        </Text>
      </Pressable>
    </Animated.View>
  );
});

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps) {
  const navigation = useNavigation();
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";
  const foregroundColor = useThemeColor("--color-foreground");
  const bodyText = useScaledTextRole("body");
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
  const settingsSheetPresentation = useThreadSettingsSheetPresentation({
    editorRef: inputRef,
    isEditorFocused: isFocused,
  });
  const settingsRoutePresentation = useExistingThreadSettingsRoutePresentation();
  const settingsRoutePresentedRef = useRef(false);
  const usageSheetPresentation = useThreadSettingsSheetPresentation({
    editorRef: inputRef,
    isEditorFocused: isFocused,
  });
  const usageRoutePresentation = useProviderUsageRoutePresentation();
  const usageRoutePresentedRef = useRef(false);
  /**
   * One composer overlay at a time. Settings and provider usage are separate
   * native routes now, and each pushes its own; the navigator does not
   * arbitrate between them, so two opens landing in the same frame would stack
   * two form sheets in a single transition and leave the second one revealed
   * when the first is dismissed. A ref, not state: both taps can arrive before
   * React re-renders, so `isActive` would still read false for both.
   */
  const overlaySheetOwnerRef = useRef<"settings" | "usage" | null>(null);
  const wasExpandedBeforePreviewRef = useRef(false);
  const inFlightThreadIdsRef = useRef(new Set<string>());
  const { onExpandedChange } = props;

  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);
  const hasContent = props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0;
  // Opening and presentation count as active so the composer stays expanded
  // while focus moves between its native editor and either native sheet.
  const isExpanded =
    isFocused || settingsSheetPresentation.isActive || usageSheetPresentation.isActive;
  const canSend = hasContent;

  // Notify the parent from the derived value, not focus events: the parent
  // sizes the feed inset from this, and blur-during-sheet would otherwise
  // report collapsed while the composer still renders expanded.
  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  const onPressImage = useCallback(
    (uri: string) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewImageUri(uri);
    },
    [isFocused],
  );

  const closePreview = useCallback(() => {
    setPreviewImageUri(null);
    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [inputRef]);

  const onEditorFocusChange = props.onEditorFocusChange;
  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onEditorFocusChange?.(true);
  }, [onEditorFocusChange]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    onEditorFocusChange?.(false);
    void flushComposerDrafts();
  }, [onEditorFocusChange]);
  const showStopAction =
    props.selectedThread.session?.status === "running" ||
    props.selectedThread.session?.status === "starting";

  // Queueing only differs from the default while the turn is running: any
  // other time a send already queues for the next turn.
  const canQueueForLater = showStopAction && canSend;

  const sendLabel = threadComposerSendLabel({
    connectionState: props.connectionState,
    queueCount: props.queueCount,
    sessionStatus: props.selectedThread.session?.status ?? null,
  });
  const currentModelSelection = props.selectedThread.modelSelection;
  const currentRuntimeMode = props.selectedThread.runtimeMode;
  const connectionStatus = composerConnectionStatus({
    connectionError: props.connectionError,
    connectionState: props.connectionState,
    environmentLabel: props.environmentLabel,
    threadSyncPhase: props.threadSyncPhase,
  });
  const toolbarSurface = String(useThemeColor("--color-card"));
  const backdropSurface = String(useThemeColor("--color-screen"));
  const toolbarFadeOpaque = themeColorWithAlpha(toolbarSurface, 0.95);
  const toolbarFadeTransparent = themeColorWithAlpha(toolbarSurface, 0);
  const backdropGradient = `linear-gradient(to bottom, ${themeColorWithAlpha(backdropSurface, 0)} 0%, ${themeColorWithAlpha(backdropSurface, 0.6)} 55%, ${themeColorWithAlpha(backdropSurface, 0.9)} 100%)`;
  const providerUsageInstanceId = resolveProviderUsageInstanceId({
    liveSessionInstanceId: props.selectedThread.session?.providerInstanceId,
    modelSelectionInstanceId: props.selectedThread.modelSelection.instanceId,
  });
  const selectedProviderStatus = useMemo(() => {
    if (!props.serverConfig) return null;
    return (
      props.serverConfig.providers.find((p) => p.instanceId === providerUsageInstanceId) ?? null
    );
  }, [props.serverConfig, providerUsageInstanceId]);
  const selectedThreadDetail = useSelectedThreadDetail();
  const providerUsageQuery = useEnvironmentQuery(
    serverEnvironment.providerUsage({
      environmentId: props.environmentId,
      input: {},
    }),
  );
  const providerUsageNowMs = useMinuteClockMs();
  const providerUsageSnapshotByInstance = useMemo(
    () =>
      new Map(
        (providerUsageQuery.data?.snapshots ?? []).map((snapshot) => [
          snapshot.instanceId,
          snapshot,
        ]),
      ),
    [providerUsageQuery.data?.snapshots],
  );
  const activityProviderUsage = useMemo(
    () =>
      deriveLatestProviderUsageSnapshot(selectedThreadDetail?.activities ?? [], {
        provider: selectedProviderStatus?.driver ?? null,
        providerInstanceId: providerUsageInstanceId,
        now: providerUsageNowMs,
      }),
    [
      providerUsageInstanceId,
      providerUsageNowMs,
      selectedProviderStatus?.driver,
      selectedThreadDetail,
    ],
  );
  // Gateway-backed instances (CLIProxyAPI) report a pool of upstream accounts
  // in one snapshot. Mobile has no settings mirror, so gateway-ness is
  // detected from the snapshot payload itself.
  const gatewayUsageByInstance = useMemo(() => {
    const pools = new Map<
      string,
      NonNullable<ReturnType<typeof deriveProviderUsageAccountsFromServerSnapshot>>
    >();
    for (const [instanceId, snapshot] of providerUsageSnapshotByInstance) {
      const pool = deriveProviderUsageAccountsFromServerSnapshot(snapshot, {
        now: providerUsageNowMs,
      });
      if (pool !== null) pools.set(instanceId, pool);
    }
    return pools;
  }, [providerUsageNowMs, providerUsageSnapshotByInstance]);
  const activeGatewayPool = useMemo(
    () =>
      providerUsageInstanceId !== null
        ? (gatewayUsageByInstance.get(providerUsageInstanceId) ?? null)
        : null,
    [gatewayUsageByInstance, providerUsageInstanceId],
  );
  const activeProviderUsageModel = resolveProviderUsageModel({
    liveSessionInstanceId: props.selectedThread.session?.providerInstanceId,
    persistedModel: props.persistedModel,
    selectedModel: props.selectedThread.modelSelection.model,
  });
  /** Which upstream of a gateway pool serves this thread's active model. */
  const activeUpstreamProvider = useMemo<string | null>(() => {
    const model = activeProviderUsageModel;
    return resolveProviderUsageUpstreamProvider({
      payload:
        providerUsageInstanceId === null
          ? undefined
          : providerUsageSnapshotByInstance.get(providerUsageInstanceId)?.payload,
      model,
      isCustom:
        selectedProviderStatus?.models.find((entry) => entry.slug === model)?.isCustom === true,
      driver: selectedProviderStatus?.driver ?? null,
    });
  }, [
    activeProviderUsageModel,
    providerUsageInstanceId,
    providerUsageSnapshotByInstance,
    selectedProviderStatus,
  ]);
  const serverProviderUsage = useMemo(() => {
    if (providerUsageInstanceId === null) return null;
    const snapshot = providerUsageSnapshotByInstance.get(providerUsageInstanceId);
    return snapshot
      ? deriveProviderUsageSnapshotFromServerSnapshot(snapshot, {
          provider: selectedProviderStatus?.driver ?? null,
          now: providerUsageNowMs,
          preferredUpstreamProvider: activeUpstreamProvider,
        })
      : null;
  }, [
    activeUpstreamProvider,
    providerUsageInstanceId,
    providerUsageNowMs,
    providerUsageSnapshotByInstance,
    selectedProviderStatus?.driver,
  ]);
  const providerUsage =
    serverProviderUsage ?? (activeGatewayPool === null ? activityProviderUsage : null);
  const readThreadGatewayAccountCommand = useAtomCommand(
    serverEnvironment.readProviderUsageThreadAccount,
    // Best-effort marker: a failed probe just leaves the badge off.
    { reportFailure: false },
  );
  // The pooled account the thread's live session is bound to, read from the
  // gateway when the usage sheet opens. Kept with the thread and model it was
  // probed for, so an answer landing after a switch cannot mislabel the new
  // context; a mismatch just means "unknown", which renders as no badge.
  const [threadGatewayAccount, setThreadGatewayAccount] =
    useState<ProviderUsageThreadAccountState | null>(null);
  const lastThreadAccountProbeRef = useRef<ProviderUsageThreadAccountProbe>({
    key: "",
    askedAtMs: 0,
  });
  const probeThreadGatewayAccount = useCallback(
    (options?: { readonly force?: boolean }) => {
      const threadId = props.selectedThread.id;
      // Only a Claude session has a binding the server can read. Mobile has
      // no settings mirror to tell a gateway instance from a direct one, so a
      // direct-instance thread costs one RPC the server answers null — that
      // beats gating on the usage snapshot, which would skip the probe on the
      // first open after a launch, before any snapshot has arrived.
      if (
        selectedProviderStatus?.driver !== "claudeAgent" ||
        props.selectedThread.session == null
      ) {
        return;
      }
      const model = activeProviderUsageModel;
      const probeKey = `${threadId}:${model}`;
      const nowMs = Date.now();
      if (
        !shouldProbeProviderUsageThreadAccount(
          lastThreadAccountProbeRef.current,
          probeKey,
          nowMs,
          options?.force === true,
        )
      ) {
        return;
      }
      lastThreadAccountProbeRef.current = { key: probeKey, askedAtMs: nowMs };
      void (async () => {
        const result = await readThreadGatewayAccountCommand({
          environmentId: props.environmentId,
          input: { threadId, model },
        });
        if (result._tag === "Failure") return;
        // A newer thread or model claimed the slot while this probe was in
        // flight; its answer must not be evicted by this stale one.
        if (lastThreadAccountProbeRef.current.key !== probeKey) return;
        const authIndex = result.value.authIndex;
        setThreadGatewayAccount(authIndex === null ? null : { threadId, model, authIndex });
      })();
    },
    [
      activeProviderUsageModel,
      props.environmentId,
      props.selectedThread.id,
      props.selectedThread.session,
      readThreadGatewayAccountCommand,
      selectedProviderStatus?.driver,
    ],
  );
  const providerUsageAccounts = useMemo(() => {
    if (activeGatewayPool !== null && providerUsageInstanceId !== null) {
      const featuredId =
        featuredProviderUsageAccount(activeGatewayPool.accounts, activeUpstreamProvider)?.id ??
        null;
      // The verified-binding badges only apply where the server can read a
      // binding (Claude sessions). Elsewhere the featured account keeps the
      // legacy "current" so e.g. a Codex thread does not lose its badge.
      const bindingSupported = selectedProviderStatus?.driver === "claudeAgent";
      const boundAuthIndex = bindingSupported
        ? resolveProviderUsageBoundAuthIndex(
            threadGatewayAccount,
            props.selectedThread.id,
            activeProviderUsageModel,
          )
        : null;
      const displayAccounts = listProviderUsageAccountsForDisplay(activeGatewayPool.accounts);
      // A binding to an account no row shows (disabled since the session
      // bound) would leave "next" pointing at an account that is not in
      // play; better to show nothing than the wrong badge.
      const boundRowVisible =
        boundAuthIndex !== null &&
        displayAccounts.some(
          (account) => account.authIndex !== null && account.authIndex === boundAuthIndex,
        );
      const observedAt =
        providerUsageSnapshotByInstance.get(providerUsageInstanceId)?.observedAt ?? null;
      return displayAccounts.map((account) => ({
        instanceId: providerUsageInstanceId,
        accountKey: `${providerUsageInstanceId}:${account.id}`,
        ...presentProviderUsageAccount(account),
        isCurrent: bindingSupported
          ? boundRowVisible && account.authIndex === boundAuthIndex
          : account.id === featuredId,
        ...(bindingSupported
          ? {
              isNext: (boundAuthIndex === null || boundRowVisible) && account.id === featuredId,
            }
          : {}),
        snapshot: account.usage,
        observedAt,
      }));
    }
    return (props.serverConfig?.providers ?? [])
      .filter(
        (provider) =>
          provider.enabled &&
          selectedProviderStatus !== null &&
          providerUsageLabelForDriver(selectedProviderStatus.driver) !== null &&
          provider.driver === selectedProviderStatus.driver &&
          // A gateway sibling meters its own pool; it renders when a thread
          // actually runs on it.
          !gatewayUsageByInstance.has(provider.instanceId),
      )
      .sort((left, right) => {
        if (left.instanceId === providerUsageInstanceId) return -1;
        if (right.instanceId === providerUsageInstanceId) return 1;
        return 0;
      })
      .map((provider) => {
        const snapshot = providerUsageSnapshotByInstance.get(provider.instanceId);
        return {
          instanceId: provider.instanceId,
          displayName: provider.displayName ?? provider.instanceId,
          email: provider.auth.email,
          isCurrent: provider.instanceId === providerUsageInstanceId,
          snapshot: snapshot
            ? deriveProviderUsageSnapshotFromServerSnapshot(snapshot, {
                provider: provider.driver,
                now: providerUsageNowMs,
              })
            : null,
          observedAt: snapshot?.observedAt ?? null,
        };
      });
  }, [
    activeGatewayPool,
    activeProviderUsageModel,
    activeUpstreamProvider,
    gatewayUsageByInstance,
    props.selectedThread.id,
    props.serverConfig?.providers,
    providerUsageInstanceId,
    providerUsageNowMs,
    providerUsageSnapshotByInstance,
    selectedProviderStatus,
    threadGatewayAccount,
  ]);
  const fableUsageSelection = useMemo(
    () =>
      resolveProviderUsageFableRing({
        upstreamProvider: activeUpstreamProvider,
        accounts: activeGatewayPool?.accounts ?? null,
        snapshot: providerUsage,
      }),
    [activeGatewayPool, activeUpstreamProvider, providerUsage],
  );
  const [isRefreshingProviderUsage, setIsRefreshingProviderUsage] = useState(false);
  const refreshProviderUsageCommand = useAtomCommand(serverEnvironment.refreshProviderUsage, {
    reportFailure: false,
  });
  const lastProviderUsageRefreshAtRef = useRef(0);
  // Identifies the in-flight refresh. The composer outlives an environment
  // switch, so a refresh started for the previous environment must not clear
  // the pending state — or report progress — for the current one.
  const providerUsageRefreshTokenRef = useRef(0);
  useEffect(() => {
    providerUsageRefreshTokenRef.current += 1;
    lastProviderUsageRefreshAtRef.current = 0;
    setIsRefreshingProviderUsage(false);
  }, [props.environmentId]);
  useEffect(
    // Unmount invalidates any in-flight token so its completion is a no-op.
    () => () => {
      providerUsageRefreshTokenRef.current += 1;
    },
    [],
  );
  const handleRefreshProviderUsage = useCallback(() => {
    // An explicit refresh ask re-reads the binding past its cadence cap; a
    // concurrent identical ask joins the same RPC via single-flight.
    probeThreadGatewayAccount({ force: true });
    const instanceIds = providerUsageAccounts.map((account) => account.instanceId);
    if (instanceIds.length === 0) return;
    // Same 5s debounce the web meter uses: each refresh can spawn a CLI
    // probe per account, so a double-tap must not double-spawn.
    if (!canStartProviderUsageRefresh(lastProviderUsageRefreshAtRef.current, Date.now())) {
      return;
    }
    lastProviderUsageRefreshAtRef.current = Date.now();
    providerUsageRefreshTokenRef.current += 1;
    const token = providerUsageRefreshTokenRef.current;
    setIsRefreshingProviderUsage(true);
    void (async () => {
      try {
        await refreshProviderUsageCommand({
          environmentId: props.environmentId,
          input: { instanceIds },
        });
        if (providerUsageRefreshTokenRef.current !== token) return;
        providerUsageQuery.refresh();
      } finally {
        if (providerUsageRefreshTokenRef.current === token) {
          setIsRefreshingProviderUsage(false);
        }
      }
    })();
    // `providerUsageQuery` itself is a fresh view object every render — listing
    // it here would churn this callback's identity, and with it the sheet
    // session memoized from it. The session feeds an effect that re-presents
    // the sheet from a provider above the navigator, so that churn is a render
    // loop that starves the sheet's own presentation frame: the panel never
    // opens. `refresh` alone is atom-keyed and stable, so it is safe to depend on.
  }, [
    probeThreadGatewayAccount,
    props.environmentId,
    providerUsageAccounts,
    providerUsageQuery.refresh,
    refreshProviderUsageCommand,
  ]);
  const providerUsagePanelObservedAt = useMemo(
    () => oldestProviderUsageObservedAt(providerUsageAccounts),
    [providerUsageAccounts],
  );
  const providerUsageLabel =
    providerUsage?.providerLabel ??
    providerUsageLabelForDriver(selectedProviderStatus?.driver) ??
    "Provider";
  const providerUsagePrimaryWindow = providerUsage
    ? primaryProviderUsageWindow(providerUsage)
    : null;
  // Fable has its own row, so it must not repaint the primary dot.
  const providerUsageStatus = providerUsageRingStatus(
    providerUsage,
    fableUsageSelection?.window.id ?? null,
  );
  const composerOwnerId = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const usageRouteSession = useMemo<ProviderUsageRouteSession>(
    () => ({
      ownerId: composerOwnerId,
      providerLabel: providerUsageLabel,
      accounts: providerUsageAccounts,
      fableUsage: fableUsageSelection,
      nowMs: providerUsageNowMs,
      panelObservedAt: providerUsagePanelObservedAt,
      refreshing: isRefreshingProviderUsage,
      onRefresh: handleRefreshProviderUsage,
      unavailable: providerUsageQuery.error !== null,
    }),
    [
      composerOwnerId,
      fableUsageSelection,
      handleRefreshProviderUsage,
      isRefreshingProviderUsage,
      providerUsageAccounts,
      providerUsageLabel,
      providerUsageNowMs,
      providerUsagePanelObservedAt,
      providerUsageQuery.error,
    ],
  );
  const openProviderUsageSheet = useCallback(() => {
    if (overlaySheetOwnerRef.current !== null) return;
    overlaySheetOwnerRef.current = "usage";
    usageRoutePresentation.present(usageRouteSession);
    usageSheetPresentation.open();
    // Unlike the staleness-gated pool refresh below, the thread-account probe
    // runs on every open: the binding is one cheap request and can change
    // independently of the pool's quota data. It throttles itself.
    probeThreadGatewayAccount();
    // Opening the sheet is the read: refresh a snapshot older than a minute so
    // it can't show yesterday's quota, exactly as the web popover does. The
    // last attempt caps the cadence — an account that never reports would
    // otherwise re-probe the whole pool on every open.
    if (
      shouldRefreshProviderUsageOnOpen(
        providerUsageAccounts,
        Date.now(),
        lastProviderUsageRefreshAtRef.current,
      )
    ) {
      handleRefreshProviderUsage();
    }
  }, [
    handleRefreshProviderUsage,
    probeThreadGatewayAccount,
    providerUsageAccounts,
    usageRoutePresentation.present,
    usageRouteSession,
    usageSheetPresentation.open,
  ]);
  useEffect(() => {
    if (usageSheetPresentation.isActive) {
      usageRoutePresentation.present(usageRouteSession);
    }
  }, [usageRoutePresentation.present, usageRouteSession, usageSheetPresentation.isActive]);
  useEffect(() => {
    if (!usageSheetPresentation.isVisible || usageRoutePresentedRef.current) {
      return;
    }

    usageRoutePresentedRef.current = true;
    navigation.dispatch(StackActions.push("ProviderUsageSheet"));
  }, [navigation, usageSheetPresentation.isVisible]);
  const providerSkills = props.providerSkills;

  // ── Trigger detection ────────────────────────────────────
  const [composerSelection, setComposerSelection] = useState(() => ({
    start: props.draftMessage.length,
    end: props.draftMessage.length,
  }));

  const handleSelectionChange = useCallback((selection: ComposerEditorSelection) => {
    setComposerSelection(selection);
  }, []);
  useEffect(() => {
    const end = props.draftMessage.length;
    setComposerSelection((selection) => {
      const start = Math.min(selection.start, end);
      const selectionEnd = Math.min(selection.end, end);
      if (start === selection.start && selectionEnd === selection.end) {
        return selection;
      }
      return { start, end: selectionEnd };
    });
  }, [props.draftMessage.length]);

  const composerTrigger = useMemo<ComposerTrigger | null>(() => {
    if (composerSelection.start !== composerSelection.end) {
      return null;
    }
    return detectComposerTrigger(props.draftMessage, composerSelection.end);
  }, [composerSelection, props.draftMessage]);
  const pathSearch = useComposerPathSearch({
    environmentId: props.environmentId,
    cwd: composerTrigger?.kind === "path" ? props.projectCwd : null,
    query: composerTrigger?.kind === "path" ? composerTrigger.query : null,
  });

  const composerMenuItems: ComposerCommandItem[] = useMemo(() => {
    if (!composerTrigger) return [];

    if (composerTrigger.kind === "slash-command") {
      const q = composerTrigger.query.toLowerCase();
      const allBuiltIn = [
        {
          id: "cmd:model",
          type: "slash-command" as const,
          command: "model",
          label: "/model",
          description: "Switch model",
        },
        {
          id: "cmd:plan",
          type: "slash-command" as const,
          command: "plan",
          label: "/plan",
          description: "Switch to plan mode",
        },
        {
          id: "cmd:default",
          type: "slash-command" as const,
          command: "default",
          label: "/default",
          description: "Switch to default mode",
        },
        {
          id: "cmd:t3-name",
          type: "slash-command" as const,
          command: "t3-name",
          label: "/t3-name",
          description: "Edit current thread name",
        },
        {
          id: "cmd:t3-rename",
          type: "slash-command" as const,
          command: "t3-rename",
          label: "/t3-rename",
          description: "Set a new thread name",
        },
        {
          id: "cmd:t3-status",
          type: "slash-command" as const,
          command: "t3-status",
          label: "/t3-status",
          description: "Set this thread's status emoji",
        },
      ];
      const builtIn = allBuiltIn.filter((item) => item.command.includes(q));

      const providerCommands: ComposerCommandItem[] = [];
      for (const cmd of selectedProviderStatus?.slashCommands ?? []) {
        if (!cmd.name.toLowerCase().includes(q)) continue;
        providerCommands.push({
          id: `pcmd:${cmd.name}`,
          type: "provider-slash-command" as const,
          command: cmd,
          label: `/${cmd.name}`,
          description: cmd.description ?? "",
        });
      }

      const skillItems = providerSkills
        .filter((skill) => matchesSlashSkillQuery(skill, q))
        .map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: `skill:${skill.name}`,
          description: skill.shortDescription ?? skill.description ?? "",
        }));

      return [...builtIn, ...providerCommands, ...skillItems];
    }

    if (composerTrigger.kind === "skill") {
      const enabledSkills = providerSkills.filter((s) => s.enabled);
      const normalizedQuery = normalizeSearchQuery(composerTrigger.query, {
        trimLeadingPattern: /^\$+/,
      });

      if (!normalizedQuery) {
        return enabledSkills.slice(0, 20).map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: skill.displayName ?? skill.name,
          description: skill.shortDescription ?? skill.description ?? "",
        }));
      }

      const ranked: Array<{
        item: (typeof enabledSkills)[number];
        score: number;
        tieBreaker: string;
      }> = [];
      for (const skill of enabledSkills) {
        const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
        const scores = [
          scoreQueryMatch({
            value: skill.name.toLowerCase(),
            query: normalizedQuery,
            exactBase: 0,
            prefixBase: 2,
            boundaryBase: 4,
            includesBase: 6,
            fuzzyBase: 100,
            boundaryMarkers: ["-", "_", "/"],
          }),
          scoreQueryMatch({
            value: displayLabel,
            query: normalizedQuery,
            exactBase: 1,
            prefixBase: 3,
            boundaryBase: 5,
            includesBase: 7,
            fuzzyBase: 110,
          }),
          scoreQueryMatch({
            value: skill.shortDescription?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 20,
            prefixBase: 22,
            boundaryBase: 24,
            includesBase: 26,
          }),
          scoreQueryMatch({
            value: skill.description?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 30,
            prefixBase: 32,
            boundaryBase: 34,
            includesBase: 36,
          }),
        ].filter((s): s is number => s !== null);

        if (scores.length > 0) {
          insertRankedSearchResult(
            ranked,
            {
              item: skill,
              score: Math.min(...scores),
              tieBreaker: `${displayLabel}\u0000${skill.name}`,
            },
            20,
          );
        }
      }

      return ranked.map(({ item: skill }) => ({
        id: `skill:${skill.name}`,
        type: "skill" as const,
        skill,
        label: skill.displayName ?? skill.name,
        description: skill.shortDescription ?? skill.description ?? "",
      }));
    }

    if (composerTrigger.kind === "path") {
      return pathSearch.entries.map((entry) => {
        const parts = entry.path.split("/");
        return {
          id: `path:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          kind: entry.kind,
          label: parts[parts.length - 1] ?? entry.path,
          description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
        };
      });
    }

    return [];
  }, [composerTrigger, pathSearch.entries, providerSkills, selectedProviderStatus]);

  // ── Handle command selection ──────────────────────────────
  const { onChangeDraftMessage, onUpdateInteractionMode, draftMessage, onSendMessage } = props;

  const handleSend = useCallback(
    async (options?: SendMessageOptions) => {
      const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
      if (inFlightThreadIdsRef.current.has(threadKey)) return;
      inFlightThreadIdsRef.current.add(threadKey);
      try {
        const messageId = await onSendMessage(options);
        if (messageId !== null) {
          // Classification happens in the state hook first, so local composer
          // commands never arm. Waiting for the optimistic enqueue keeps native
          // activity work off the initiating tap frame.
          armAgentAwarenessLiveActivityForLocalWork({
            environmentId: props.environmentId,
            threadTitle: props.selectedThread.title,
            projectTitle: props.environmentLabel ?? "T3 Code",
          });
        }
      } finally {
        inFlightThreadIdsRef.current.delete(threadKey);
      }
    },
    [
      onSendMessage,
      props.environmentId,
      props.environmentLabel,
      props.selectedThread.id,
      props.selectedThread.title,
    ],
  );

  // Press/submit handlers receive their own event argument, so they can never
  // be wired straight to `handleSend` without it being read as send options.
  const handleSendDefault = useCallback(() => {
    void handleSend();
  }, [handleSend]);

  const handleQueueForLater = useCallback(() => {
    void handleSend({ deliveryIntent: "queue" });
  }, [handleSend]);
  const handleCommandSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (!composerTrigger) return;

      if (
        item.type === "slash-command" &&
        (item.command === "plan" || item.command === "default")
      ) {
        const result = replaceTextRange(
          draftMessage,
          composerTrigger.rangeStart,
          composerTrigger.rangeEnd,
          "",
        );
        setComposerSelection({ start: result.cursor, end: result.cursor });
        onChangeDraftMessage(result.text);
        onUpdateInteractionMode(item.command);
        return;
      }

      let replacement = "";
      if (item.type === "path") {
        replacement = `${serializeComposerFileLink(item.path)} `;
      } else if (item.type === "skill") {
        replacement = `$${item.skill.name} `;
      } else if (item.type === "slash-command") {
        replacement =
          item.command === "t3-name" || item.command === "t3-rename"
            ? buildThreadTitleComposerText(item.command, props.selectedThread.title)
            : `/${item.command} `;
      } else if (item.type === "provider-slash-command") {
        replacement = `/${item.command.name} `;
      }

      const result = replaceTextRange(
        draftMessage,
        composerTrigger.rangeStart,
        composerTrigger.rangeEnd,
        replacement,
      );
      setComposerSelection({ start: result.cursor, end: result.cursor });
      onChangeDraftMessage(result.text);
    },
    [
      composerTrigger,
      draftMessage,
      onChangeDraftMessage,
      onUpdateInteractionMode,
      props.selectedThread.title,
    ],
  );

  // ── Model menu ───────────────────────────────────────────
  const modelOptions = useMemo(
    () => buildModelOptions(props.serverConfig, currentModelSelection),
    [props.serverConfig, currentModelSelection],
  );
  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  // An existing thread is bound to its harness: sessions can't move between
  // provider instances, so the picker only offers the thread's own group.
  const threadProviderGroups = useMemo(
    () => providerGroups.filter((group) => group.providerKey === currentModelSelection.instanceId),
    [providerGroups, currentModelSelection.instanceId],
  );
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null;
  const providerOptionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: currentModelSelection.options,
      }),
    [currentModelOption?.capabilities, currentModelSelection.options],
  );
  const settingsAccessibilityValue = useMemo(
    () =>
      [
        currentModelOption?.label ?? currentModelSelection.model,
        ...providerOptionValueLabels(providerOptionDescriptors),
        RUNTIME_MODE_CHOICES.find((choice) => choice.mode === currentRuntimeMode)?.label,
      ]
        .filter((value): value is string => value !== undefined)
        .join(" · "),
    [
      currentModelOption?.label,
      currentModelSelection.model,
      currentRuntimeMode,
      providerOptionDescriptors,
    ],
  );
  const settingsRouteSession = useMemo<ExistingThreadSettingsRouteSession>(
    () => ({
      ownerId: composerOwnerId,
      providerGroups: threadProviderGroups,
      selectedModel: currentModelSelection,
      onSelectModel: (option) => props.onUpdateModelSelection(option.selection),
      optionDescriptors: providerOptionDescriptors,
      onUpdateOptionSelections: (options) =>
        props.onUpdateModelSelection({ ...currentModelSelection, options }),
      runtimeMode: currentRuntimeMode,
      onUpdateRuntimeMode: props.onUpdateRuntimeMode,
    }),
    [
      composerOwnerId,
      currentModelSelection,
      currentRuntimeMode,
      props.onUpdateModelSelection,
      props.onUpdateRuntimeMode,
      providerOptionDescriptors,
      threadProviderGroups,
    ],
  );
  const openSettings = useCallback(() => {
    if (overlaySheetOwnerRef.current !== null) return;
    overlaySheetOwnerRef.current = "settings";
    settingsRoutePresentation.present(settingsRouteSession);
    settingsSheetPresentation.open();
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.open]);

  useEffect(() => {
    if (settingsSheetPresentation.isActive) {
      settingsRoutePresentation.present(settingsRouteSession);
    }
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.isActive]);

  useEffect(() => {
    if (!settingsSheetPresentation.isVisible || settingsRoutePresentedRef.current) {
      return;
    }

    settingsRoutePresentedRef.current = true;
    navigation.dispatch(StackActions.push("ThreadSettingsSheet"));
  }, [navigation, settingsSheetPresentation.isVisible]);

  useFocusEffect(
    useCallback(() => {
      if (settingsRoutePresentedRef.current) {
        settingsRoutePresentedRef.current = false;
        settingsSheetPresentation.onDismissed();
        settingsRoutePresentation.clear(composerOwnerId);
      }
      if (usageRoutePresentedRef.current) {
        usageRoutePresentedRef.current = false;
        usageSheetPresentation.onDismissed();
        usageRoutePresentation.clear(composerOwnerId);
      }
      // The composer regaining focus means no overlay route is above it, so
      // release the owner even if an open never reached its presented ref
      // (a tap that blurred the editor but was dismissed before presenting).
      overlaySheetOwnerRef.current = null;
    }, [
      composerOwnerId,
      settingsRoutePresentation.clear,
      settingsSheetPresentation.onDismissed,
      usageRoutePresentation.clear,
      usageSheetPresentation.onDismissed,
    ]),
  );

  useEffect(
    () =>
      // UIKit's completion callback for sheet dismissal, surfaced by the
      // native-stack patch. This is when any queued keyboard restore runs.
      (navigation as unknown as NavigationWithFinishTransitioning).addListener(
        "finishTransitioning",
        () => {
          settingsSheetPresentation.onStackTransitionsFinished();
          usageSheetPresentation.onStackTransitionsFinished();
        },
      ),
    [
      navigation,
      settingsSheetPresentation.onStackTransitionsFinished,
      usageSheetPresentation.onStackTransitionsFinished,
    ],
  );

  // The long-press menu is invisible to assistive tech, so while queueing is
  // available the same choice is also exposed as an accessibility action.
  const sendToolbarButton = (
    <ComposerToolbarButton
      accessibilityLabel={sendLabel}
      {...(canQueueForLater
        ? {
            accessibilityActions: [{ name: "queue", label: "Queue for later" }],
            onAccessibilityAction: (event: AccessibilityActionEvent) => {
              if (event.nativeEvent.actionName === "queue") {
                handleQueueForLater();
              }
            },
          }
        : {})}
      icon="arrow.up"
      variant="primary"
      disabled={!canSend}
      onPress={handleSendDefault}
      showChevron={false}
    />
  );

  return (
    <Animated.View
      className="px-4"
      layout={COMPOSER_LAYOUT_TRANSITION}
      style={{
        paddingTop: isExpanded ? 8 : 6,
        paddingBottom: (props.bottomInset ?? 0) + (isExpanded ? 8 : 6),
      }}
    >
      {/* The backdrop gradient lives on a plain View: Reanimated's Animated.View
          silently drops experimental_backgroundImage on Android, which left this
          strip fully transparent and the feed text legible through the composer. */}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            experimental_backgroundImage: backdropGradient,
          },
        ]}
      />
      <Animated.View
        className="relative w-full self-center"
        layout={COMPOSER_LAYOUT_TRANSITION}
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {composerTrigger && composerMenuItems.length > 0 ? (
          <View className="absolute inset-x-0 bottom-full z-10 mb-2">
            <ComposerCommandPopover
              items={composerMenuItems}
              triggerKind={composerTrigger.kind}
              isLoading={pathSearch.isPending}
              onSelect={handleCommandSelect}
            />
          </View>
        ) : null}

        {connectionStatus ? (
          <ComposerConnectionStatusPill
            status={connectionStatus}
            onPress={props.onReconnectEnvironment}
          />
        ) : null}

        <ComposerSurface
          isDarkMode={isDarkMode}
          style={
            isExpanded
              ? {
                  borderRadius: 26,
                  minHeight: 140,
                  overflow: "hidden" as const,
                  paddingBottom: 6,
                  paddingHorizontal: 14,
                  paddingTop: 14,
                }
              : {
                  borderRadius: 999,
                  overflow: "hidden" as const,
                  flexDirection: "row" as const,
                  alignItems: "center" as const,
                  paddingLeft: 18,
                  paddingRight: 5,
                  paddingVertical: 5,
                }
          }
        >
          {/* Attachment strip — inside the card, above the text input */}
          {isExpanded ? (
            <Animated.View
              className={props.draftAttachments.length > 0 ? "pb-2.5" : undefined}
              entering={FadeIn.duration(160)}
              exiting={FadeOut.duration(120)}
            >
              <ComposerAttachmentStrip
                attachments={props.draftAttachments}
                onRemove={props.onRemoveDraftImage}
                onPressImage={onPressImage}
              />
            </Animated.View>
          ) : null}

          <View className={isExpanded ? undefined : "min-w-0 flex-1"}>
            <ComposerEditor
              ref={inputRef}
              multiline
              value={props.draftMessage}
              skills={providerSkills}
              selection={composerSelection}
              onChangeText={props.onChangeDraftMessage}
              onSelectionChange={handleSelectionChange}
              onPasteImages={(uris) => void props.onNativePasteImages(uris)}
              placeholder={props.placeholder}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onSubmit={handleSendDefault}
              scrollEnabled={isExpanded}
              // Android: collapsed single line centers natively (gravity) in
              // a pill-height box matching the send button; iOS keeps insets.
              singleLineCentered={!isExpanded}
              contentInsetVertical={isExpanded || Platform.OS === "android" ? 0 : 6}
              style={
                isExpanded
                  ? {
                      minHeight: 72,
                      maxHeight: 160,
                      paddingHorizontal: 4,
                      paddingVertical: 4,
                    }
                  : {
                      height: 36,
                    }
              }
              textStyle={{
                ...bodyText,
                color: foregroundColor,
              }}
            />
          </View>
          {!isExpanded && props.draftAttachments.length > 0 ? (
            <View className="flex-row gap-1 pl-1">
              {props.draftAttachments.slice(0, 3).map((image) => (
                <Pressable key={image.id} onPress={() => onPressImage(image.previewUri)}>
                  <Image
                    source={{ uri: image.previewUri }}
                    className="size-[30px] rounded-lg bg-subtle"
                    resizeMode="cover"
                  />
                </Pressable>
              ))}
              {props.draftAttachments.length > 3 ? (
                <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                  <Text className="text-foreground-muted text-2xs font-t3-bold">
                    +{props.draftAttachments.length - 3}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {!isExpanded ? (
            <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(100)}>
              {showStopAction ? (
                <ControlPill icon="stop.fill" variant="danger" onPress={props.onStopThread} />
              ) : (
                <ControlPill
                  icon="arrow.up"
                  variant="primary"
                  disabled={!canSend}
                  onPress={handleSendDefault}
                />
              )}
            </Animated.View>
          ) : null}
          {isExpanded ? (
            <ComposerToolbarRow paddingBottom={0} paddingHorizontal={0} paddingTop={4}>
              <ComposerToolbarScroller
                fadeOpaque={toolbarFadeOpaque}
                fadeTransparent={toolbarFadeTransparent}
                contentPaddingRight={8}
              >
                <ComposerToolbarButton
                  accessibilityLabel="Add attachment"
                  icon="plus"
                  onPress={() => void props.onPickDraftImages()}
                  showChevron={false}
                />
                {props.serverConfig?.speechToText.available === true ? (
                  <VoiceRecorderControl
                    key={`${props.environmentId}:${props.selectedThread.id}`}
                    environmentId={props.environmentId}
                    disabled={props.connectionState !== "connected"}
                    onTranscript={props.onVoiceTranscript}
                  />
                ) : null}
                <ComposerToolbarButton
                  accessibilityLabel="Model and reasoning settings"
                  accessibilityValue={{ text: settingsAccessibilityValue }}
                  iconNode={
                    <ProviderIcon provider={currentModelOption?.providerDriver} size={16} />
                  }
                  label={currentModelOption?.label ?? currentModelSelection.model}
                  maxWidth={152}
                  onPress={openSettings}
                />
                {providerUsageAccounts.length > 0 ? (
                  <ComposerToolbarButton
                    accessibilityLabel={`${providerUsageLabel} usage`}
                    iconNode={
                      <View
                        className={cn(
                          "h-2 w-2 rounded-full",
                          providerUsageStatus === "critical"
                            ? "bg-rose-500"
                            : providerUsageStatus === "warning"
                              ? "bg-amber-500"
                              : "bg-foreground-muted",
                        )}
                      />
                    }
                    label={providerUsageTriggerLabel(providerUsagePrimaryWindow)}
                    onPress={openProviderUsageSheet}
                  />
                ) : null}
                {showStopAction ? (
                  <ComposerToolbarButton
                    accessibilityLabel="Stop"
                    icon="stop.fill"
                    variant="danger"
                    onPress={props.onStopThread}
                    showChevron={false}
                  />
                ) : null}
              </ComposerToolbarScroller>
              {canQueueForLater ? (
                // Long-press only: the tap still steers into the running turn.
                <ControlPillMenu
                  actions={SEND_MENU_ACTIONS}
                  shouldOpenOnLongPress
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === "queue") {
                      handleQueueForLater();
                    }
                  }}
                >
                  {sendToolbarButton}
                </ControlPillMenu>
              ) : (
                sendToolbarButton
              )}
            </ComposerToolbarRow>
          ) : null}
        </ComposerSurface>

        {/* Queue count */}
        {props.queueCount > 0 ? (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
            <Text className="pt-2 text-xs text-foreground-muted">
              {props.queueCount} queued message{props.queueCount === 1 ? "" : "s"} will send
              automatically.
            </Text>
          </Animated.View>
        ) : null}
      </Animated.View>
      <ImageViewing
        images={previewImageUri ? [{ uri: previewImageUri }] : []}
        imageIndex={0}
        visible={previewImageUri !== null}
        onRequestClose={closePreview}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </Animated.View>
  );
});
