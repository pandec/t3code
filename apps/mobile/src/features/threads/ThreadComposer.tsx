import { useAtomValue } from "@effect/atom-react";
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
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  View,
  type AccessibilityActionEvent,
  type ViewStyle,
} from "react-native";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "../../state/composer-attachment-uploads";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutDown,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { scopedThreadKey } from "../../lib/scopedEntities";

import { AppText as Text } from "../../components/AppText";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import {
  ComposerAttachmentStrip,
  ComposerAttachmentThumbnail,
} from "../../components/ComposerAttachmentStrip";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { GlassSurface } from "../../components/GlassSurface";
import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarButton,
  ComposerToolbarRow,
} from "../../components/ComposerToolbar";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";
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
  resolveProviderUsageInstanceId,
  resolveProviderUsageModel,
  resolveProviderUsageUpstreamProvider,
} from "@t3tools/client-runtime/state/provider-usage";
import { cn } from "../../lib/cn";
import type {
  DraftComposerAttachment,
  DraftComposerFileAttachment,
} from "../../lib/composerImages";
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
import type { RemoteClientConnectionState } from "../../lib/connection";
import {
  providerOptionValueLabels,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { ComposerCommandPopover } from "./ComposerCommandPopover";
import { useComposerCommandMenu } from "./use-composer-command-menu";
import { RUNTIME_MODE_CHOICES } from "./thread-settings-options";
import { threadComposerSendLabel } from "./threadComposerSendLabel";
import {
  type ProviderUsageRouteSession,
  useProviderUsageRoutePresentation,
} from "./ProviderUsageSheet";
import {
  ComposerDictationCancelAction,
  ComposerDictationDraftContent,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "./ThreadSettingsSheet";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";

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
  readonly draftAttachments: ReadonlyArray<DraftComposerAttachment>;
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
  readonly onPickDraftMedia: () => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
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
// The bottom-anchored dock position and clipped surface height use the same
// transition so the card grows upward without exposing its final-size content.
// Android gets NO layout transition: the composer rides the keyboard via
// KeyboardStickyView (frame-synced to the IME), and a time-based morph
// running alongside that translate reads as jitter. Snapping the layout and
// letting the keyboard-synced slide be the only motion looks native there.
export const COMPOSER_TRANSITION_DURATION_MS = 220;
export const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === "android"
    ? undefined
    : LinearTransition.duration(COMPOSER_TRANSITION_DURATION_MS).reduceMotion(ReduceMotion.System);

const AnimatedGlassSurface = Animated.createAnimatedComponent(GlassSurface);

export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  /** Morphs between the compact and expanded composer layouts. */
  readonly animateLayout?: boolean;
}) {
  const targetBorderRadius =
    typeof props.style.borderRadius === "number" ? props.style.borderRadius : 0;
  const animatedBorderRadius = useSharedValue(targetBorderRadius);
  const shouldAnimate = props.animateLayout !== false && Platform.OS !== "android";
  useLayoutEffect(() => {
    animatedBorderRadius.value = shouldAnimate
      ? withTiming(targetBorderRadius, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : targetBorderRadius;
  }, [animatedBorderRadius, shouldAnimate, targetBorderRadius]);
  const animatedShapeStyle = useAnimatedStyle(() => ({
    borderRadius: animatedBorderRadius.value,
  }));
  const layoutTransition = shouldAnimate ? COMPOSER_LAYOUT_TRANSITION : undefined;

  // Each native frame follows the same transition. Animating only the outer
  // clip leaves the glass and content at their final height on the first frame.
  return (
    <Animated.View
      className="shadow-[0_6px_28px] shadow-adaptive-black-a15-a35"
      layout={layoutTransition}
      style={[
        animatedShapeStyle,
        {
          overflow: "hidden",
          // Android versions before 9 do not support outset box shadows.
          elevation: Platform.OS === "android" && Platform.Version < 28 ? 10 : undefined,
        },
      ]}
    >
      <AnimatedGlassSurface
        chrome="none"
        fallbackClassName="border border-border bg-card-translucent"
        glassEffectStyle="regular"
        // The composer is a passive material containing interactive controls.
        // Keep native glass out of the interactive content's layout path.
        pointerEvents="none"
        tintColor="transparent"
        layout={layoutTransition}
        style={[{ position: "absolute", inset: 0 }, animatedShapeStyle]}
      >
        {null}
      </AnimatedGlassSurface>
      <Animated.View
        collapsable={false}
        layout={layoutTransition}
        style={[props.style, animatedShapeStyle]}
      >
        {props.children}
      </Animated.View>
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
          <ActivityIndicator size="small" colorClassName={"accent-icon-muted"} />
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
  const foregroundColor = useUniwindTheme()["--color-foreground"];
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
  const overlaySheetOwnerRef = useRef<"settings" | "usage" | "attachment" | "preview" | null>(null);
  const wasExpandedBeforePreviewRef = useRef(false);
  const inFlightThreadIdsRef = useRef(new Set<string>());
  const { onExpandedChange } = props;

  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const hasContent = props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0;
  const threadIsBusy =
    props.selectedThread.session?.status === "running" ||
    props.selectedThread.session?.status === "starting";
  const showStopAction = !hasContent && threadIsBusy;

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
  const composerOwnerKey = scopedThreadKey(props.environmentId, props.selectedThread.id);

  const composerMenu = useComposerCommandMenu({
    draftMessage: props.draftMessage,
    ownerKey: composerOwnerKey,
    environmentId: props.environmentId,
    projectCwd: props.projectCwd,
    selectedProviderStatus,
    providerSkills: props.providerSkills,
    hasThread: true,
    threadTitle: props.selectedThread.title,
    onChangeDraftMessage: props.onChangeDraftMessage,
    onUpdateInteractionMode: props.onUpdateInteractionMode,
  });
  const voiceInput = useVoiceInputController({
    ownerKey: composerOwnerKey,
    environmentId: props.environmentId,
    environmentTranscriptionAvailable:
      props.connectionState === "connected" && props.serverConfig?.speechToText.available === true,
    draftMessage: props.draftMessage,
    selection: composerMenu.selection,
    onCommitVoiceDraftMessage: props.onVoiceTranscript,
    onChangeSelection: composerMenu.onSelectionChange,
  });
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const isVoiceInputPresented = voicePresentation.statusLabel !== null;
  // Opening and presentation count as active so focus can move from the editor
  // into either native sheet without collapsing the composer underneath it.
  const isExpanded =
    isFocused || settingsSheetPresentation.isActive || usageSheetPresentation.isActive;
  const showsCompactDictation = isVoiceInputPresented && !isExpanded;
  const isToolbarVisible = isExpanded || isVoiceInputPresented;
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const attachmentBlockReason = composerAttachmentUploadBlockReason({
    environmentId: props.environmentId,
    attachments: props.draftAttachments,
    connected: props.connectionState === "connected",
    serverConfig: props.serverConfig,
    states: uploadStates,
  });
  const canSend = hasContent && !voiceInput.blocksSubmission && attachmentBlockReason === null;
  const canQueueForLater = threadIsBusy && canSend;

  // Keep the feed inset aligned with the card or compact dictation strip.
  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  const onPressPreview = useCallback(
    (source: FilePreviewSource) => {
      if (overlaySheetOwnerRef.current !== null) return;
      overlaySheetOwnerRef.current = "preview";
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewVideo(null);
      setPreviewFile(source);
    },
    [isFocused],
  );

  const closePreview = useCallback(() => {
    setPreviewFile(null);
    setPreviewVideo(null);
    if (overlaySheetOwnerRef.current === "preview") {
      overlaySheetOwnerRef.current = null;
    }
    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => {
        if (navigation.isFocused()) inputRef.current?.focus();
      }, 100);
    }
  }, [inputRef, navigation]);

  const onPressVideo = useCallback(
    (attachment: DraftComposerFileAttachment, sourceIdentifier: string) => {
      if (overlaySheetOwnerRef.current !== null) return;
      overlaySheetOwnerRef.current = "preview";
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewFile(null);
      setPreviewVideo({ type: "local", attachment, sourceIdentifier });
    },
    [isFocused],
  );

  const onEditorFocusChange = props.onEditorFocusChange;
  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onExpandedChange?.(true);
    onEditorFocusChange?.(true);
  }, [onEditorFocusChange, onExpandedChange]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    if (!settingsSheetPresentation.isActive && !usageSheetPresentation.isActive) {
      onExpandedChange?.(false);
    }
    onEditorFocusChange?.(false);
    void flushComposerDrafts();
  }, [
    onEditorFocusChange,
    onExpandedChange,
    settingsSheetPresentation.isActive,
    usageSheetPresentation.isActive,
  ]);
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
  const { onSendMessage } = props;

  const handleSend = useCallback(
    async (options?: SendMessageOptions) => {
      if (voiceInput.blocksSubmission || attachmentBlockReason !== null) return;
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
      attachmentBlockReason,
      onSendMessage,
      props.environmentId,
      props.environmentLabel,
      props.selectedThread.id,
      props.selectedThread.title,
      voiceInput.blocksSubmission,
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
      environmentId: props.environmentId,
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
  const handleAttachmentOverlayVisibilityChange = useCallback((visible: boolean) => {
    if (visible) {
      if (overlaySheetOwnerRef.current === null) {
        overlaySheetOwnerRef.current = "attachment";
      }
      return;
    }
    if (overlaySheetOwnerRef.current === "attachment") {
      overlaySheetOwnerRef.current = null;
    }
  }, []);

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
  const sendActionButton = (
    <ComposerActionButton
      accessibilityLabel={attachmentBlockReason ?? sendLabel}
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
    />
  );
  const sendAction = canQueueForLater ? (
    <ControlPillMenu
      actions={SEND_MENU_ACTIONS}
      shouldOpenOnLongPress
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "queue") handleQueueForLater();
      }}
    >
      {sendActionButton}
    </ControlPillMenu>
  ) : (
    sendActionButton
  );

  return (
    <Animated.View
      className="px-[12px]"
      style={{
        paddingTop: isExpanded ? 8 : 6,
        paddingBottom: (props.bottomInset ?? 0) + (isExpanded ? 8 : 6),
      }}
    >
      {/* The backdrop gradient lives on a plain View: Reanimated's Animated.View
          silently drops experimental_backgroundImage on Android, which left this
          strip fully transparent and the feed text legible through the composer. */}
      <View
        className="absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        pointerEvents="none"
      />
      <Animated.View
        className="relative w-full self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {!voiceInput.isBusy && composerMenu.trigger && composerMenu.items.length > 0 ? (
          <View className="absolute inset-x-0 bottom-full z-10 mb-2">
            <ComposerCommandPopover
              items={composerMenu.items}
              triggerKind={composerMenu.trigger.kind}
              isLoading={composerMenu.isLoading}
              onSelect={composerMenu.onSelect}
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
          style={
            isExpanded
              ? {
                  borderRadius: 26,
                  minHeight: 140,
                  overflow: "hidden" as const,
                  paddingBottom: 6,
                  paddingTop: 14,
                }
              : {
                  // Keep the numeric radius close to the expanded card so the
                  // shape morph stays bounded while rendering as a capsule.
                  borderRadius: 27,
                  overflow: "hidden" as const,
                  paddingVertical: 2,
                }
          }
        >
          <ComposerDictationDraftContent
            className={isExpanded ? undefined : "flex-row items-center"}
            compact={!isExpanded}
            hidden={showsCompactDictation}
          >
            {!isExpanded ? (
              <ComposerAttachmentButton
                supportsFiles={Boolean(
                  props.serverConfig?.environment.capabilities.fileAttachments,
                )}
                onPickMedia={props.onPickDraftMedia}
                onPickFiles={props.onPickDraftFiles}
                onOverlayVisibilityChange={handleAttachmentOverlayVisibilityChange}
              />
            ) : null}
            {isExpanded ? (
              <Animated.View
                className={props.draftAttachments.length > 0 ? "px-[14px] pb-2.5" : undefined}
                entering={FadeIn.duration(160)}
                exiting={FadeOut.duration(120)}
              >
                <ComposerAttachmentStrip
                  environmentId={props.environmentId}
                  attachments={props.draftAttachments}
                  onRemove={voiceInput.isBusy ? () => undefined : props.onRemoveDraftImage}
                  onPressPreview={voiceInput.isBusy ? undefined : onPressPreview}
                  onPressVideo={voiceInput.isBusy ? undefined : onPressVideo}
                />
              </Animated.View>
            ) : null}
            <Animated.View
              className={isExpanded ? "px-[14px]" : "min-w-0 flex-1 px-[4px]"}
              layout={COMPOSER_LAYOUT_TRANSITION}
            >
              <ComposerEditor
                ref={inputRef}
                multiline
                value={props.draftMessage}
                readOnly={voiceInput.freezesEditor}
                skills={props.providerSkills}
                selection={composerMenu.selection}
                onChangeText={props.onChangeDraftMessage}
                onSelectionChange={composerMenu.onSelectionChange}
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
            </Animated.View>
            {!isExpanded && props.draftAttachments.length > 0 ? (
              <View className="flex-row gap-1 pl-1">
                {props.draftAttachments.slice(0, 3).map((attachment) => (
                  <ComposerAttachmentThumbnail
                    environmentId={props.environmentId}
                    key={attachment.id}
                    attachment={attachment}
                    size={30}
                    borderRadius={8}
                    compact
                    onPressPreview={onPressPreview}
                    onPressVideo={onPressVideo}
                  />
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
              <View className="flex-row items-center">
                <ComposerDictationStartAction
                  state={voiceInput.state}
                  isAvailable={voiceInput.isAvailable}
                  onStart={voiceInput.start}
                  onCancel={voiceInput.cancel}
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
                  <ComposerActionButton
                    accessibilityLabel="Stop agent"
                    icon="stop.fill"
                    variant="danger"
                    onPress={props.onStopThread}
                  />
                ) : (
                  sendAction
                )}
              </View>
            ) : null}
            {isExpanded ? <View className="h-1" /> : null}
          </ComposerDictationDraftContent>
          <Animated.View
            accessibilityElementsHidden={!isToolbarVisible}
            collapsable={false}
            importantForAccessibility={isToolbarVisible ? "auto" : "no-hide-descendants"}
            layout={COMPOSER_LAYOUT_TRANSITION}
            pointerEvents={isToolbarVisible ? "auto" : "none"}
            style={
              isExpanded
                ? undefined
                : {
                    position: "absolute",
                    bottom: 2,
                    left: 0,
                    right: 0,
                  }
            }
          >
            <ComposerDictationToolbar
              showsDictation={isVoiceInputPresented}
              visible={isToolbarVisible}
            >
              <ComposerToolbarRow
                paddingBottom={0}
                paddingHorizontal={0}
                paddingTop={0}
                style={{ gap: 0 }}
              >
                <ComposerDictationCancelAction
                  presentation={voicePresentation}
                  onCancel={voiceInput.cancel}
                />
                {isVoiceInputPresented ? (
                  <ComposerDictationStatus
                    audioLevels={voiceInput.audioLevels}
                    elapsedSeconds={voiceInput.elapsedSeconds}
                    phase={voiceInput.state.phase}
                    presentation={voicePresentation}
                    onDismissError={voiceInput.cancel}
                  />
                ) : (
                  <View className="min-w-0 flex-1 flex-row items-center justify-between">
                    <ComposerAttachmentButton
                      supportsFiles={Boolean(
                        props.serverConfig?.environment.capabilities.fileAttachments,
                      )}
                      onPickMedia={props.onPickDraftMedia}
                      onPickFiles={props.onPickDraftFiles}
                      onOverlayVisibilityChange={handleAttachmentOverlayVisibilityChange}
                    />
                    <View className="min-w-0 shrink flex-row items-center">
                      <ComposerInlineControl
                        accessibilityLabel="Model and reasoning settings"
                        accessibilityValue={{ text: settingsAccessibilityValue }}
                        emphasized
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
                          maxWidth={112}
                          onPress={openProviderUsageSheet}
                          showChevron={false}
                        />
                      ) : null}
                    </View>
                  </View>
                )}
                <View className="shrink-0 flex-row items-center">
                  <ComposerDictationPrimaryAction
                    state={voiceInput.state}
                    presentation={voicePresentation}
                    isAvailable={voiceInput.isAvailable}
                    onStart={voiceInput.start}
                    onConfirm={voiceInput.stop}
                    onCancel={voiceInput.cancel}
                  />
                  {showStopAction ? (
                    <ComposerActionButton
                      accessibilityLabel="Stop agent"
                      icon="stop.fill"
                      variant="danger"
                      onPress={props.onStopThread}
                    />
                  ) : voicePresentation.showsSend && isToolbarVisible ? (
                    sendAction
                  ) : null}
                </View>
              </ComposerToolbarRow>
            </ComposerDictationToolbar>
          </Animated.View>
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

      <VideoPreviewModal source={previewVideo} onRequestClose={closePreview} />
      <FilePreviewModal source={previewFile} onRequestClose={closePreview} />
    </Animated.View>
  );
});
