import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { resolveEffectiveProviderSkills } from "@t3tools/client-runtime/state/server";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import { useKeyboardChatComposerInset, useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import type {
  ApprovalRequestId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationThreadShell,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
  ThreadId,
  UserInputQuestion,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import {
  AppState,
  Keyboard,
  Platform,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import {
  KeyboardController,
  KeyboardStickyView,
  useKeyboardState,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Animated, {
  Easing,
  FadeInDown,
  FadeOut,
  useAnimatedReaction,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPill } from "../../components/ControlPill";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import type { StatusTone } from "../../components/StatusPill";
import { flushMobileDiagnostics, recordMobileDiagnostic } from "../../diagnostics/journal";
import {
  awaitBoundedKeyboardDismiss,
  requiresKeyboardStickyResetWait,
} from "../../lib/boundedKeyboardDismiss";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { requestKeyboardStickyReset } from "../../lib/keyboardStickyResetRequests";
import { CHAT_CONTENT_MAX_WIDTH, type LayoutVariant } from "../../lib/layout";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { scopedThreadKey } from "../../lib/scopedEntities";
import type {
  PendingApproval,
  PendingUserInput,
  PendingUserInputDraftAnswer,
  ThreadFeedEntry,
} from "../../lib/threadActivity";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { SendMessageOptions } from "../../state/use-thread-composer-state";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { QueuedMessageList } from "./QueuedMessageList";
import {
  derivePendingUserInputMaxHeight,
  ESTIMATED_KEYBOARD_HEIGHT,
  USER_INPUT_TOGGLE_DURATION_MS,
} from "./pendingUserInputLayout";
import {
  COMPOSER_COLLAPSED_CHROME,
  COMPOSER_EXPANDED_CHROME,
  ThreadComposer,
} from "./ThreadComposer";
import { ThreadFeed } from "./ThreadFeed";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import { resolveThreadFeedSubmissionAnchor } from "./thread-feed-live-follow";
import { resolveThreadFeedInsetBaseline } from "./threadFeedInsets";
import type { ThreadHistoryWindowState } from "./threadHistoryLoadMore";

export interface ThreadDetailScreenProps {
  readonly selectedThread: OrchestrationThreadShell;
  readonly persistedModel: string;
  readonly contentPresentation: ThreadContentPresentation;
  readonly screenTone: StatusTone;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  readonly selectedThreadFeed: ReadonlyArray<ThreadFeedEntry>;
  /**
   * User messages steered into the running turn that are still sitting in the
   * provider's prompt queue. Their bubbles say so, because "sent" and "read"
   * can be minutes apart behind a long tool call.
   */
  readonly steerPendingMessageIds: ReadonlySet<MessageId>;
  readonly threadHistoryWindow: ThreadHistoryWindowState;
  readonly activeWorkStartedAt: string | null;
  readonly activePendingApproval: PendingApproval | null;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly connectionStateLabel: EnvironmentConnectionPhase;
  /** Message sync status for the selected thread (drives the composer status pill). */
  readonly threadSyncStatus?: EnvironmentThreadStatus;
  readonly environmentId: EnvironmentId;
  readonly projectWorkspaceRoot: string | null;
  readonly threadCwd: string | null;
  readonly selectedThreadQueueCount: number;
  readonly serverConfig: T3ServerConfig | null;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onVoiceTranscript: (text: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: (options?: SendMessageOptions) => Promise<MessageId | null>;
  readonly onReconnectEnvironment: () => void;
  readonly onUpdateThreadModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateThreadRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateThreadInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  readonly onSelectUserInputOption: (
    requestId: ApprovalRequestId,
    question: UserInputQuestion,
    label: string,
  ) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmitUserInput: () => Promise<unknown>;
  readonly showContent?: boolean;
}

function latestStreamingAssistantMessage(
  feed: ReadonlyArray<ThreadFeedEntry>,
): { readonly id: string; readonly textLength: number } | null {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (entry?.type !== "message") {
      continue;
    }
    if (entry.message.role !== "assistant" || !entry.message.streaming) {
      continue;
    }
    return {
      id: entry.message.id,
      textLength: entry.message.text.length,
    };
  }

  return null;
}

function useStreamingHaptics(threadId: ThreadId, feed: ReadonlyArray<ThreadFeedEntry>) {
  const lastStreamingAssistantRef = useRef<{
    readonly id: string;
    readonly textLength: number;
  } | null>(null);
  const lastStreamHapticAtRef = useRef(0);
  const hydratedRef = useRef(false);
  const previousThreadIdRef = useRef(threadId);

  useEffect(() => {
    if (previousThreadIdRef.current !== threadId) {
      previousThreadIdRef.current = threadId;
      hydratedRef.current = false;
    }

    const latestStreamingMessage = latestStreamingAssistantMessage(feed);

    if (!hydratedRef.current) {
      hydratedRef.current = true;
      lastStreamingAssistantRef.current = latestStreamingMessage;
      return;
    }

    if (!latestStreamingMessage) {
      lastStreamingAssistantRef.current = null;
      return;
    }

    const previousStreamingMessage = lastStreamingAssistantRef.current;
    lastStreamingAssistantRef.current = latestStreamingMessage;

    const isNewStream = previousStreamingMessage?.id !== latestStreamingMessage.id;
    const textGrew =
      previousStreamingMessage?.id === latestStreamingMessage.id &&
      latestStreamingMessage.textLength > previousStreamingMessage.textLength;

    if (!isNewStream && !textGrew) {
      return;
    }

    const now = Date.now();
    if (!isNewStream && now - lastStreamHapticAtRef.current < 320) {
      return;
    }

    lastStreamHapticAtRef.current = now;
    void Haptics.selectionAsync();
  }, [threadId, feed]);
}

const USER_INPUT_TOGGLE_TIMING = {
  duration: USER_INPUT_TOGGLE_DURATION_MS,
  easing: Easing.out(Easing.cubic),
};

export const ThreadDetailScreen = memo(function ThreadDetailScreen(props: ThreadDetailScreenProps) {
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const liveKeyboardHeight = useKeyboardState((state) => state.height);
  // Android can swallow the IME hide callbacks when the app is backgrounded
  // mid keyboard-hide (the reported repro: send — which blurs and starts the
  // hide — then Home within a second). The keyboard library's height AND
  // visibility then stay frozen open, so gating the sticky translation on
  // visibility alone still strands the composer after resume. Quarantine the
  // translation on every Android resume instead; any sign of a live keyboard
  // stream — an owned input gaining focus, or any visibility/height movement —
  // lifts it. A healthy resume sees no visual difference (the translation is
  // already zero while the keyboard is closed).
  const [keyboardStateSuspect, setKeyboardStateSuspect] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setKeyboardStateSuspect(true);
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    setKeyboardStateSuspect(false);
  }, [isKeyboardVisible, liveKeyboardHeight]);
  const handleOwnedInputFocusChange = useCallback((focused: boolean) => {
    if (focused) {
      setKeyboardStateSuspect(false);
    }
  }, []);
  const windowHeight = useWindowDimensions().height;
  const navigationHeaderHeight = useContext(HeaderHeightContext) || insets.top + IOS_NAV_BAR_HEIGHT;
  const agentLabel = `${props.selectedThread.modelSelection.instanceId} agent`;
  const selectedThreadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const composerEditorRef = useRef<ComposerEditorHandle>(null);
  const composerOverlayRef = useRef<View>(null);
  const listRef = useRef<LegendListRef>(null);
  const feedTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  const lastScrolledSubmittedMessageIdRef = useRef<MessageId | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [anchorMessageId, setAnchorMessageId] = useState<MessageId | null>(null);
  const [submittedMessageId, setSubmittedMessageId] = useState<MessageId | null>(null);
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  const [measuredComposerOverlay, setMeasuredComposerOverlay] = useState<{
    readonly threadKey: string;
    readonly height: number;
  } | null>(null);
  const measuredComposerOverlayHeight =
    measuredComposerOverlay?.threadKey === selectedThreadKey
      ? measuredComposerOverlay.height
      : null;
  const keyboardAnimation = useReanimatedKeyboardAnimation();
  // Android keys the safe-area padding on keyboard visibility (#5988). iOS
  // keys it on focus so the inset is already present during the hide animation.
  const composerBottomInset = (Platform.OS === "android" ? isKeyboardVisible : composerExpanded)
    ? 0
    : Math.max(insets.bottom, 12);
  const contentPresentationKind = props.contentPresentation.kind;
  // The raw sync status enters "synchronizing" on every full fetch, cached or
  // not. Whether messages are already on screen decides the pill label: no
  // data yet → "Loading messages", cached data reconciling → "Syncing".
  const threadSyncPhase = (() => {
    switch (props.threadSyncStatus) {
      case "empty":
      case "cached":
      case "synchronizing":
        if (contentPresentationKind === "ready") {
          return "syncing" as const;
        }
        return contentPresentationKind === "loading" ? ("loading" as const) : null;
      default:
        return null;
    }
  })();
  const selectedThreadFeed = props.selectedThreadFeed;
  const composerChrome = composerExpanded ? COMPOSER_EXPANDED_CHROME : COMPOSER_COLLAPSED_CHROME;
  const composerOverlapHeight = composerChrome + composerBottomInset;
  // While a user-input request is pending, the questionnaire owns the
  // composer slot outright: expanded it is the full card, collapsed it is a
  // composer-style bar in the same place (with its own stop control). The
  // composer never mounts into the transition, which keeps the collapse and
  // keyboard animations coherent. Collapse state is keyed by request id so a
  // new request re-expands automatically.
  const [collapsedUserInputRequestId, setCollapsedUserInputRequestId] =
    useState<ApprovalRequestId | null>(null);
  const activeUserInputRequestId = props.activePendingUserInput?.requestId ?? null;
  const userInputCollapsed =
    activeUserInputRequestId !== null && collapsedUserInputRequestId === activeUserInputRequestId;
  // The card's height RESERVES keyboard space at all times instead of
  // tracking the keyboard: transforms (the sticky translation) apply
  // same-frame on the UI thread while layout props lag a Yoga pass behind,
  // so any height that follows the keyboard flashes the card over the nav
  // header on the way up. With a constant height the keyboard transition is
  // pure translation — frame-perfect by construction — and the resting card
  // stays compact over the transcript. Before the first open the reserve is
  // an estimate; once a real height is known the card corrects once,
  // discretely.
  const [lastKnownKeyboardHeight, setLastKnownKeyboardHeight] = useState(0);
  useEffect(() => {
    if (liveKeyboardHeight > 0 && liveKeyboardHeight !== lastKnownKeyboardHeight) {
      setLastKnownKeyboardHeight(liveKeyboardHeight);
    }
  }, [lastKnownKeyboardHeight, liveKeyboardHeight]);
  const pendingUserInputMaxHeight = derivePendingUserInputMaxHeight({
    windowHeight,
    keyboardHeight:
      lastKnownKeyboardHeight > 0 ? lastKnownKeyboardHeight : ESTIMATED_KEYBOARD_HEIGHT,
    navigationHeaderHeight,
    // The questionnaire owns the composer slot, so only the composer's
    // bottom inset still overlaps.
    composerOverlapHeight: composerBottomInset,
  });
  const estimatedOverlayHeight = composerOverlapHeight;
  // The overlay's measured height includes the home-indicator inset (the
  // composer pads it), but contentInsetAdjustmentBehavior="automatic" makes
  // UIKit add the safe-area bottom to the content inset AGAIN — leaving a
  // dead strip between the resting content and the composer. Report the
  // overlay height minus the safe area; UIKit adds it back, and ThreadFeed
  // hands LegendList the same delta via contentInsetEndStaticAdjustment so
  // its end-scroll math matches the real resting position.
  const nativeInsetOvercount =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios" ? insets.bottom : 0;
  const estimatedContentInsetBaseline = resolveThreadFeedInsetBaseline({
    measuredOverlayHeight: null,
    estimatedOverlayHeight,
    nativeInsetOvercount,
  });
  const contentInsetBaseline = resolveThreadFeedInsetBaseline({
    measuredOverlayHeight: measuredComposerOverlayHeight,
    estimatedOverlayHeight,
    nativeInsetOvercount,
  });
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    composerOverlayRef,
    estimatedContentInsetBaseline,
    -nativeInsetOvercount,
  );
  const handleComposerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      setMeasuredComposerOverlay((current) =>
        current?.threadKey === selectedThreadKey && current.height === height
          ? current
          : { threadKey: selectedThreadKey, height },
      );
      onComposerLayout(event);
    },
    [onComposerLayout, selectedThreadKey],
  );
  // The expanded questionnaire is an absolute overlay on iOS, so it never
  // changes the measured overlay height. Shared values keep the card and feed
  // inset animations synchronized without React layout round trips.
  const userInputCardProgress = useSharedValue(1);
  const userInputInsetProgress = useSharedValue(1);
  const userInputCardCoverage = useSharedValue(0);
  const userInputCoverageApplies = Platform.OS === "ios" && activeUserInputRequestId !== null;
  const combinedContentInsetEndAdjustment = useSharedValue(
    Math.max(0, estimatedOverlayHeight - nativeInsetOvercount),
  );
  useAnimatedReaction(
    () =>
      contentInsetEndAdjustment.value +
      (userInputCoverageApplies ? userInputInsetProgress.value * userInputCardCoverage.value : 0),
    (value) => {
      combinedContentInsetEndAdjustment.value = value;
    },
    [userInputCoverageApplies],
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
  const endFollowEnabledRef = useRef(true);
  endFollowEnabledRef.current = endFollowEnabled;
  const userInputRepinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The list's own corrections for these inset changes drift on short
  // content (and the error compounds across toggles), so deterministically
  // re-pin the end once a toggle settles: a no-op when the resting position
  // is already right, corrective when it is not. Follow state is re-checked
  // inside the callback — the user may grab the list during the settle
  // window, and yanking them back would override a live gesture.
  const scheduleUserInputRepin = useCallback(
    (delayMs: number) => {
      if (userInputRepinTimerRef.current !== null) {
        clearTimeout(userInputRepinTimerRef.current);
      }
      userInputRepinTimerRef.current = setTimeout(() => {
        userInputRepinTimerRef.current = null;
        if (!endFollowEnabledRef.current) {
          return;
        }
        void scrollMessageToEnd({ animated: false, closeKeyboard: false }).catch(() => {
          freeze.set(false);
        });
      }, delayMs);
    },
    [freeze, scrollMessageToEnd],
  );
  useEffect(
    () => () => {
      if (userInputRepinTimerRef.current !== null) {
        clearTimeout(userInputRepinTimerRef.current);
      }
    },
    [],
  );
  const handleToggleUserInputCollapsed = useCallback(() => {
    if (activeUserInputRequestId === null) {
      return;
    }
    if (userInputCollapsed) {
      // Expanding: card and feed glide start NOW, on the UI thread.
      userInputCardProgress.value = withTiming(1, USER_INPUT_TOGGLE_TIMING);
      userInputInsetProgress.value = withTiming(1, USER_INPUT_TOGGLE_TIMING);
      setCollapsedUserInputRequestId(null);
      scheduleUserInputRepin(USER_INPUT_TOGGLE_DURATION_MS + 50);
    } else {
      // Collapsing hides the custom-answer inputs; release the keyboard with
      // them instead of leaving it up over a dead responder.
      Keyboard.dismiss();
      userInputCardProgress.value = withTiming(0, USER_INPUT_TOGGLE_TIMING);
      // Instant: the sinking card still covers the strip being revealed, and
      // animating the inset downward is what drifted the short-content end
      // anchor.
      userInputInsetProgress.value = 0;
      setCollapsedUserInputRequestId(activeUserInputRequestId);
      scheduleUserInputRepin(60);
    }
  }, [
    activeUserInputRequestId,
    scheduleUserInputRepin,
    userInputCardProgress,
    userInputCollapsed,
    userInputInsetProgress,
  ]);
  useEffect(() => {
    // A new request always arrives expanded.
    userInputCardProgress.value = 1;
    userInputInsetProgress.value = 1;
  }, [activeUserInputRequestId, userInputCardProgress, userInputInsetProgress]);
  const showContent = props.showContent ?? true;
  const layoutVariant = props.layoutVariant ?? "compact";
  const isSplitLayout = layoutVariant === "split";
  const contentMaxWidth = isSplitLayout ? CHAT_CONTENT_MAX_WIDTH : undefined;
  const selectedInstanceId = props.selectedThread.modelSelection.instanceId;
  useStreamingHaptics(props.selectedThread.id, props.selectedThreadFeed);
  const providerSnapshotSkills = useMemo(
    () =>
      props.serverConfig?.providers.find((provider) => provider.instanceId === selectedInstanceId)
        ?.skills ?? [],
    [props.serverConfig, selectedInstanceId],
  );
  const providerSkillsQuery = useEnvironmentQuery(
    props.threadCwd !== null
      ? serverEnvironment.providerSkills({
          environmentId: props.environmentId,
          input: { instanceId: selectedInstanceId, cwd: props.threadCwd },
        })
      : null,
  );
  const selectedProviderSkills = resolveEffectiveProviderSkills(
    providerSkillsQuery.data?.skills,
    providerSnapshotSkills,
  );

  useLayoutEffect(() => {
    selectedThreadKeyRef.current = selectedThreadKey;
  }, [selectedThreadKey]);

  useEffect(() => {
    setAnchorMessageId(null);
    setSubmittedMessageId(null);
    lastScrolledSubmittedMessageIdRef.current = null;
    setEndFollowEnabled(true);
    freeze.set(false);
  }, [freeze, selectedThreadKey]);

  useEffect(() => {
    if (
      submittedMessageId === null ||
      lastScrolledSubmittedMessageIdRef.current === submittedMessageId ||
      contentPresentationKind !== "ready" ||
      !selectedThreadFeed.some(
        (entry) => entry.type === "message" && entry.id === submittedMessageId,
      )
    ) {
      return;
    }

    const targetThreadKey = selectedThreadKey;
    const frame = requestAnimationFrame(() => {
      if (selectedThreadKeyRef.current !== targetThreadKey) {
        return;
      }
      lastScrolledSubmittedMessageIdRef.current = submittedMessageId;
      // On iOS, keep keyboard-driven inset updates alive through both the
      // deterministic reconciliation deadline and a bounded native dismiss.
      // Android retains its direct dismiss flow and aborts scrolling on failure.
      const scrollAfterKeyboardDismiss = async () => {
        if (Platform.OS === "ios") {
          const reportedVisibleBeforeDismiss = KeyboardController.isVisible();
          const keyboardHeightBeforeDismiss = keyboardAnimation.height.value;
          const offsetLooksStale = requiresKeyboardStickyResetWait({
            reportedVisible: reportedVisibleBeforeDismiss,
            keyboardHeight: keyboardHeightBeforeDismiss,
          });
          const dismissPromise = Promise.resolve().then(() => KeyboardController.dismiss());
          recordMobileDiagnostic("keyboard-sticky", {
            event: "dismiss-start",
            trigger: "anchor-scroll",
            reason: "message-send",
            reportedVisibleBeforeDismiss,
            offsetLooksStale,
          });
          const dismissOutcome = await awaitBoundedKeyboardDismiss(
            dismissPromise,
            offsetLooksStale ? undefined : { minimumWaitMs: 0 },
          );
          recordMobileDiagnostic("keyboard-sticky", {
            event: "dismiss-outcome",
            trigger: "anchor-scroll",
            reason: "message-send",
            outcome: dismissOutcome,
          });
          if (dismissOutcome !== "settled") {
            void flushMobileDiagnostics();
          }
        } else {
          recordMobileDiagnostic("keyboard-sticky", {
            event: "dismiss-start",
            trigger: "anchor-scroll",
            reason: "message-send",
            reportedVisibleBeforeDismiss: null,
          });
          try {
            await KeyboardController.dismiss();
            recordMobileDiagnostic("keyboard-sticky", {
              event: "dismiss-outcome",
              trigger: "anchor-scroll",
              reason: "message-send",
              outcome: "settled",
            });
          } catch {
            recordMobileDiagnostic("keyboard-sticky", {
              event: "dismiss-outcome",
              trigger: "anchor-scroll",
              reason: "message-send",
              outcome: "rejected",
            });
            void flushMobileDiagnostics();
            if (
              selectedThreadKeyRef.current === targetThreadKey &&
              lastScrolledSubmittedMessageIdRef.current === submittedMessageId
            ) {
              lastScrolledSubmittedMessageIdRef.current = null;
              freeze.set(false);
            }
            return;
          }
        }

        if (
          selectedThreadKeyRef.current !== targetThreadKey ||
          lastScrolledSubmittedMessageIdRef.current !== submittedMessageId
        ) {
          return;
        }

        try {
          await scrollMessageToEnd({ animated: true, closeKeyboard: false });
        } catch {
          if (
            selectedThreadKeyRef.current !== targetThreadKey ||
            lastScrolledSubmittedMessageIdRef.current !== submittedMessageId
          ) {
            return;
          }
          lastScrolledSubmittedMessageIdRef.current = null;
          freeze.set(false);
        }
      };
      void scrollAfterKeyboardDismiss();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    submittedMessageId,
    freeze,
    keyboardAnimation.height,
    contentPresentationKind,
    selectedThreadFeed,
    scrollMessageToEnd,
    selectedThreadKey,
  ]);

  const handleAnchorEndSpaceConsumed = useCallback((messageId: MessageId) => {
    setAnchorMessageId((current) => (current === messageId ? null : current));
  }, []);

  const handleSendMessage = useCallback(
    async (options?: SendMessageOptions) => {
      const targetThreadKey = selectedThreadKey;
      const hasUserMessage = selectedThreadFeed.some(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
      const messageId = await props.onSendMessage(options);
      if (messageId === null || selectedThreadKeyRef.current !== targetThreadKey) {
        return messageId;
      }

      setSubmittedMessageId(messageId);
      setAnchorMessageId((currentAnchorMessageId) =>
        resolveThreadFeedSubmissionAnchor({
          currentAnchorMessageId,
          submittedMessageId: messageId,
          hasStartedTurn: props.selectedThread.latestTurn !== null,
          hasUserMessage,
          queuedMessageCount: props.selectedThreadQueueCount,
        }),
      );
      composerEditorRef.current?.blur();
      const stickyResetHandled = requestKeyboardStickyReset("message-send");
      recordMobileDiagnostic("keyboard-sticky", {
        event: "request-dispatched",
        trigger: "message-send",
        reason: "message-send",
        handled: stickyResetHandled,
      });
      return messageId;
    },
    [
      props.onSendMessage,
      props.selectedThread.latestTurn,
      props.selectedThreadQueueCount,
      selectedThreadFeed,
      selectedThreadKey,
    ],
  );

  const collapseComposer = useCallback(() => {
    composerEditorRef.current?.blur();
  }, []);

  const handleScrollToEnd = useCallback(() => {
    void Haptics.selectionAsync();
    void scrollMessageToEnd({ animated: true, closeKeyboard: false }).catch(() => {
      freeze.set(false);
    });
  }, [freeze, scrollMessageToEnd]);

  const showScrollToEndButton = contentPresentationKind === "ready" && !endFollowEnabled;
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";

  const handleFeedTouchStart = useCallback((event: GestureResponderEvent) => {
    feedTouchStartRef.current = {
      pageX: event.nativeEvent.pageX,
      pageY: event.nativeEvent.pageY,
    };
  }, []);

  const handleFeedTouchMove = useCallback((event: GestureResponderEvent) => {
    const start = feedTouchStartRef.current;
    if (!start) {
      return;
    }
    const deltaX = event.nativeEvent.pageX - start.pageX;
    const deltaY = event.nativeEvent.pageY - start.pageY;
    if (Math.hypot(deltaX, deltaY) > 8) {
      feedTouchStartRef.current = null;
    }
  }, []);

  const handleFeedTouchEnd = useCallback(() => {
    if (feedTouchStartRef.current) {
      collapseComposer();
    }
    feedTouchStartRef.current = null;
  }, [collapseComposer]);

  const handleFeedTouchCancel = useCallback(() => {
    feedTouchStartRef.current = null;
  }, []);

  return (
    <View className="flex-1">
      {showContent ? (
        <View
          className="flex-1"
          onTouchStart={handleFeedTouchStart}
          onTouchMove={handleFeedTouchMove}
          onTouchEnd={handleFeedTouchEnd}
          onTouchCancel={handleFeedTouchCancel}
        >
          <ThreadFeed
            key={`${props.environmentId}:${props.selectedThread.id}`}
            environmentId={props.environmentId}
            textToSpeechAvailable={props.serverConfig?.textToSpeech.available === true}
            textToSpeechPersistentJobs={props.serverConfig?.textToSpeech.persistentJobs === true}
            messageSummariesAvailable={
              props.serverConfig?.environment.capabilities.messageSummaries === true
            }
            threadId={props.selectedThread.id}
            workspaceRoot={props.threadCwd}
            feed={props.selectedThreadFeed}
            steerPendingMessageIds={props.steerPendingMessageIds}
            historyWindow={props.threadHistoryWindow}
            contentPresentation={props.contentPresentation}
            agentLabel={agentLabel}
            latestTurn={props.selectedThread.latestTurn}
            activeWorkStartedAt={props.activeWorkStartedAt}
            listRef={listRef}
            freeze={freeze}
            anchorMessageId={anchorMessageId}
            submittedMessageId={submittedMessageId}
            onAnchorEndSpaceConsumed={handleAnchorEndSpaceConsumed}
            contentInsetEndAdjustment={combinedContentInsetEndAdjustment}
            contentInsetBaseline={contentInsetBaseline}
            keyboardVisible={isKeyboardVisible}
            contentTopInset={0}
            contentBottomInset={estimatedOverlayHeight}
            contentMaxWidth={contentMaxWidth}
            layoutVariant={layoutVariant}
            usesAutomaticContentInsets={props.usesAutomaticContentInsets}
            onHeaderMaterialVisibilityChange={props.onHeaderMaterialVisibilityChange}
            onEndFollowEnabledChange={setEndFollowEnabled}
            skills={selectedProviderSkills}
          />
        </View>
      ) : (
        <View className="flex-1" />
      )}

      {/* Floating composer — sticks to keyboard via KeyboardStickyView */}
      {showContent ? (
        <KeyboardStickyView
          // The animated keyboard height can remain stale after a dismissed
          // IME on both platforms. Visibility is the authoritative closed
          // state, so disable the translation rather than stranding the pill.
          enabled={isKeyboardVisible && !keyboardStateSuspect}
          style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
          offset={{ closed: 0, opened: 0 }}
        >
          {/* No paddingTop here: the overlay's measured height becomes the
              list's bottom inset, so any padding above the pill/composer
              pushes the resting content floor up by the same amount. */}
          <View ref={composerOverlayRef} onLayout={handleComposerLayout} className="w-full">
            {showScrollToEndButton ? (
              <Animated.View
                pointerEvents="box-none"
                className="absolute -top-11 left-0 right-0 z-20 items-center"
                entering={FadeInDown.duration(160)}
                exiting={FadeOut.duration(100)}
              >
                {isLiquidGlassSupported ? (
                  <LiquidGlassView
                    colorScheme={isDarkMode ? "dark" : "light"}
                    effect="regular"
                    interactive
                    // Interactive glass can render larger than the requested
                    // box (minimum touch size), so center the pill instead of
                    // relying on it filling the glass exactly.
                    style={{
                      alignItems: "center",
                      borderRadius: 18,
                      height: 36,
                      justifyContent: "center",
                      overflow: "hidden",
                      width: 36,
                    }}
                  >
                    <ControlPill
                      accessibilityLabel="Scroll to end"
                      activateOnPressIn
                      className="h-9 w-9 bg-transparent"
                      icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
                      onPress={handleScrollToEnd}
                    />
                  </LiquidGlassView>
                ) : (
                  <ControlPill
                    accessibilityLabel="Scroll to end"
                    activateOnPressIn
                    className="h-9 w-9 border border-border bg-card shadow-md shadow-black/10"
                    icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
                    onPress={handleScrollToEnd}
                  />
                )}
              </Animated.View>
            ) : null}
            <View className="w-full self-center" style={{ maxWidth: contentMaxWidth }}>
              {props.activePendingApproval || props.activePendingUserInput ? (
                <Animated.View
                  className="shrink-0 gap-3 px-4 pb-3"
                  // The questionnaire replaces the composer, so it must pad
                  // the home indicator the composer normally covers.
                  style={
                    activeUserInputRequestId !== null
                      ? { paddingBottom: composerBottomInset }
                      : undefined
                  }
                  entering={FadeInDown.duration(220)}
                  exiting={FadeOut.duration(140)}
                >
                  {props.activePendingApproval ? (
                    <PendingApprovalCard
                      approval={props.activePendingApproval}
                      respondingApprovalId={props.respondingApprovalId}
                      onRespond={props.onRespondToApproval}
                    />
                  ) : null}
                  {props.activePendingUserInput ? (
                    <PendingUserInputCard
                      pendingUserInput={props.activePendingUserInput}
                      maxHeight={pendingUserInputMaxHeight}
                      collapsed={userInputCollapsed}
                      onToggleCollapsed={handleToggleUserInputCollapsed}
                      onStopThread={props.onStopThread}
                      cardProgress={userInputCardProgress}
                      cardCoverage={userInputCardCoverage}
                      onInputFocusChange={handleOwnedInputFocusChange}
                      drafts={props.activePendingUserInputDrafts}
                      answers={props.activePendingUserInputAnswers}
                      respondingUserInputId={props.respondingUserInputId}
                      onSelectOption={props.onSelectUserInputOption}
                      onChangeCustomAnswer={props.onChangeUserInputCustomAnswer}
                      onSubmit={props.onSubmitUserInput}
                    />
                  ) : null}
                </Animated.View>
              ) : null}

              <QueuedMessageList
                environmentId={props.environmentId}
                threadId={props.selectedThread.id}
              />
            </View>

            {/* Hidden (not unmounted) while a user-input request owns the
                composer slot, so composer drafts and editor state survive. */}
            <View style={activeUserInputRequestId !== null ? { display: "none" } : undefined}>
              <ThreadComposer
                editorRef={composerEditorRef}
                draftMessage={props.draftMessage}
                draftAttachments={props.draftAttachments}
                placeholder="Ask the repo agent, or run a command…"
                contentMaxWidth={contentMaxWidth}
                connectionState={props.connectionStateLabel}
                connectionError={props.connectionError}
                environmentLabel={props.environmentLabel}
                threadSyncPhase={threadSyncPhase}
                selectedThread={props.selectedThread}
                persistedModel={props.persistedModel}
                serverConfig={props.serverConfig}
                queueCount={props.selectedThreadQueueCount}
                environmentId={props.environmentId}
                projectCwd={props.projectWorkspaceRoot}
                providerSkills={selectedProviderSkills}
                bottomInset={composerBottomInset}
                onChangeDraftMessage={props.onChangeDraftMessage}
                onVoiceTranscript={props.onVoiceTranscript}
                onPickDraftImages={props.onPickDraftImages}
                onNativePasteImages={props.onNativePasteImages}
                onRemoveDraftImage={props.onRemoveDraftImage}
                onStopThread={props.onStopThread}
                onSendMessage={handleSendMessage}
                onReconnectEnvironment={props.onReconnectEnvironment}
                onUpdateModelSelection={props.onUpdateThreadModelSelection}
                onUpdateRuntimeMode={props.onUpdateThreadRuntimeMode}
                onUpdateInteractionMode={props.onUpdateThreadInteractionMode}
                onExpandedChange={setComposerExpanded}
                onEditorFocusChange={handleOwnedInputFocusChange}
              />
            </View>
          </View>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
});
