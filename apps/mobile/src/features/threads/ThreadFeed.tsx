import * as Haptics from "expo-haptics";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { type LegendListRef } from "@legendapp/list/react-native";
import type {
  EnvironmentId,
  MessageId,
  MessageSpeechFailureReason,
  MessageSpeechRequest,
  MessageSpeechSynthesisResult,
  MessageSummaryResult,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { consumeOwnedMessageSpeechRequest } from "@t3tools/client-runtime/operations";
import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import {
  formatListeningClock,
  formatListeningSpeed,
  LISTENING_SPEED_MAX,
  LISTENING_SPEED_MIN,
  LISTENING_SPEED_PRESETS,
  listeningSpeedSpokenLabel,
  type ListeningTrackRef,
} from "@t3tools/shared/listeningPlayback";
import { formatElapsed } from "@t3tools/shared/orchestrationTiming";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useNavigation } from "@react-navigation/native";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Markdown,
  type CustomRenderers,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  type ColorValue,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeInUp, type SharedValue } from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";
import { listeningPlayerChrome } from "./listeningPlayerChrome";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { useFontFamily } from "../../lib/useFontFamily";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { hasWideMarkdownBlock } from "../../lib/wideMarkdownBlocks";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type MarkdownImageRenderer,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";

import { AppText as Text } from "../../components/AppText";
import { CopyTextButton } from "../../components/CopyTextButton";
import {
  parseReviewCommentMessageSegments,
  type ReviewInlineComment,
} from "../review/reviewCommentSelection";
import type { ReviewDiffTheme } from "../review/shikiReviewHighlighter";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { cn } from "../../lib/cn";
import {
  deriveCenteredContentHorizontalPadding,
  deriveThreadFeedInitialContentInset,
  type LayoutVariant,
} from "../../lib/layout";
import {
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
  scaledTypographyLineHeight,
} from "../../lib/appearancePreferences";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { markdownFileIconSource } from "@t3tools/mobile-markdown-text/file-icons";
import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";
import {
  deriveThreadFeedPresentationState,
  type ThreadFeedEntry,
  type ThreadFeedLatestTurn,
} from "../../lib/threadActivity";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import {
  resolveThreadFeedInsetReport,
  shouldReleaseThreadFeedAnchor,
  type ThreadFeedInsetReport,
} from "./threadFeedInsets";
import {
  decideThreadUnderfilledHistoryEffectAction,
  distanceFromFeedTop,
  shouldReleaseOlderMessagesRequest,
  shouldRequestOlderMessages,
  shouldRequestOlderMessagesForUnderfilledFeed,
  type ThreadHistoryWindowState,
} from "./threadHistoryLoadMore";
import {
  resolveThreadFeedLiveFollow,
  type ThreadFeedLiveFollowEvent,
} from "./thread-feed-live-follow";
import {
  collapsedWorkLogHeight,
  ThreadWorkGroupToggle,
  ThreadWorkLog,
  WORK_GROUP_TOGGLE_HEIGHT,
} from "./thread-work-log";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";
import { useAssetUrl, useAssetUrlState, watchAssetUrl } from "../../state/assets";
import { resolveWorkspaceRelativeFilePath } from "../files/filePath";
import { messageSpeechFailureDescription, synthesizeMessageSpeech } from "../../state/voice";
import { summarizeMessage } from "../../state/messageArtifacts";
import { threadEnvironment } from "../../state/threads";
import {
  beginMessageArtifactRequest,
  getMessageArtifactSessionSnapshot,
  rememberMessageSpeech,
  rememberMessageSummary,
  subscribeMessageArtifactSession,
} from "@t3tools/client-runtime/state/messageArtifacts";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  listeningPlayback,
  useListeningPlaybackProgress,
  useListeningPlaybackSnapshot,
} from "../../state/listeningPlayback";
import { requestListeningTrack, usePendingListeningSpeechId } from "../../state/listeningPlayer";
import { MARKDOWN_IMAGE_MAX_WIDTH, resolveMarkdownImageDisplaySize } from "./markdownImageSize";

const WIDE_MARKDOWN_BLOCK_OPTIONS = {
  includeOrderedLists: Platform.OS === "android",
} as const;

const MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
function formatMessageTime(input: string): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  return MESSAGE_TIME_FORMATTER.format(timestamp);
}

// Pre-measurement heights for getFixedItemSize, mirroring renderFeedEntry's
// classNames. The fold row's min-h-11 (44px) stays taller than its single
// text-sm line at every supported base font size (26px at the 22pt maximum),
// so its height is a constant; a drifted value costs one correction on
// measure, not a persistent offset.
const TURN_FOLD_HEIGHT = 56; // min-h-11 (44) + mb-3 (12)
// The working row has no min-height clamp — its height follows the scaled
// text-xs line height (see workingRowHeight in ThreadFeed).
const WORKING_ROW_VERTICAL_EXTRAS = 24; // py-1 (8) + mb-4 (16)

// Entering animations must only play for rows born just now — LegendList
// remounts rows when they scroll back into view, and replaying an entrance for
// old content would be its own kind of jank.
const FRESH_ENTRY_WINDOW_MS = 3_000;
function isFreshTimestamp(input: string): boolean {
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ENTRY_WINDOW_MS;
}

function haveSameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

export interface ThreadFeedProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly workspaceRoot?: string | null;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  /**
   * User messages steered into the running turn that the agent has not read
   * yet. Empty where the caller does not track them (tests, previews).
   */
  readonly steerPendingMessageIds?: ReadonlySet<MessageId>;
  /** Older-message paging state. Omitted where history is fully loaded (tests, previews). */
  readonly historyWindow?: ThreadHistoryWindowState;
  readonly contentPresentation: ThreadContentPresentation;
  readonly agentLabel: string;
  readonly latestTurn: ThreadFeedLatestTurn | null;
  readonly activeWorkStartedAt: string | null;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly freeze: SharedValue<boolean>;
  readonly anchorMessageId: MessageId | null;
  readonly submittedMessageId: MessageId | null;
  readonly onAnchorEndSpaceConsumed: (messageId: MessageId) => void;
  readonly contentInsetEndAdjustment: SharedValue<number>;
  readonly contentInsetBaseline: number;
  readonly keyboardVisible: boolean;
  readonly contentTopInset?: number;
  readonly contentBottomInset?: number;
  readonly contentMaxWidth?: number;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onEndFollowEnabledChange?: (enabled: boolean) => void;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textToSpeechAvailable?: boolean;
  readonly textToSpeechPersistentJobs?: boolean;
  readonly messageSummariesAvailable?: boolean;
}

/**
 * Ambient note on a steer the agent has not read yet. Claude Code only takes a
 * mid-turn message between a tool result and the next model request, so this
 * can stand for minutes behind a long subagent or shell call. Deliberately
 * quiet and static — it reports a wait, it does not ask for anything.
 */
function SteerPendingMarker({ tintColor }: { readonly tintColor: ColorValue }) {
  return (
    <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
      <SymbolView name="circle.dashed" size={11} tintColor={tintColor} type="monochrome" />
      <Text className="font-t3-medium text-xs text-foreground-secondary">
        Waiting for the agent to pick this up
      </Text>
    </View>
  );
}

function MessageAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly className: string;
  readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
}) {
  const uri = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.attachmentId,
  });

  // A View — not the touchable — carries the frame (aspect ratio, radius,
  // placeholder tint): gesture-handler's TouchableOpacity forwards only a fixed
  // prop allow-list plus `style` to its inner view, so `className` on it never
  // reaches a styled node. Both states fill that one frame, so the row measures
  // identically before and after the asset URL lands and the image never
  // contributes its intrinsic size.
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      disabled={uri === null}
      onPress={uri === null ? undefined : () => props.onPressImage(uri)}
    >
      <View className={cn(props.className, "overflow-hidden")}>
        {uri === null ? (
          <View className="h-full w-full items-center justify-center">
            <ActivityIndicator />
          </View>
        ) : (
          <Image source={{ uri }} className="h-full w-full" resizeMode="cover" />
        )}
      </View>
    </TouchableOpacity>
  );
}

function ThreadMarkdownImageView(props: {
  readonly uri: string | null;
  readonly sourceKey: string;
  readonly unavailable: boolean;
  readonly alt: string | null;
  readonly onPressImage: (uri: string) => void;
}) {
  const codeBackground = useThemeColor("--color-md-code-bg");
  const [availableWidth, setAvailableWidth] = useState(0);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [failedUri, setFailedUri] = useState<string | null>(null);

  useEffect(() => {
    setSourceSize(null);
  }, [props.sourceKey]);

  useEffect(() => {
    setFailedUri(null);
  }, [props.uri]);

  const displaySize =
    sourceSize === null
      ? null
      : resolveMarkdownImageDisplaySize({
          sourceWidth: sourceSize.width,
          sourceHeight: sourceSize.height,
          availableWidth,
        });
  const failed = props.unavailable || (props.uri !== null && failedUri === props.uri);
  const placeholderWidth: ViewStyle["width"] =
    availableWidth > 0 ? Math.min(availableWidth, MARKDOWN_IMAGE_MAX_WIDTH) : "100%";
  const frameStyle: ViewStyle = displaySize ?? { width: placeholderWidth, aspectRatio: 16 / 9 };

  return (
    <View
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
      style={{ alignSelf: "stretch", gap: 6 }}
    >
      {props.uri === null || failed ? (
        <View
          style={{
            ...frameStyle,
            borderRadius: 10,
            backgroundColor: codeBackground,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {failed ? (
            <Text className="text-xs text-foreground-muted">Image unavailable</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <TouchableOpacity
          accessibilityRole="imagebutton"
          accessibilityLabel={props.alt ?? "Markdown image"}
          activeOpacity={0.7}
          onPress={() => props.onPressImage(props.uri!)}
          style={{ alignSelf: "flex-start" }}
        >
          <View
            style={{
              ...frameStyle,
              borderRadius: 10,
              backgroundColor: codeBackground,
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            <ThreadMarkdownImageRequest
              key={props.uri}
              uri={props.uri}
              onLoad={setSourceSize}
              onError={() => setFailedUri(props.uri)}
            />
          </View>
        </TouchableOpacity>
      )}
      {props.alt ? (
        <Text selectable className="text-xs text-foreground-muted">
          {props.alt}
        </Text>
      ) : null}
    </View>
  );
}

function ThreadMarkdownImageRequest(props: {
  readonly uri: string;
  readonly onLoad: (sourceSize: { width: number; height: number }) => void;
  readonly onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <>
      <Image
        source={{ uri: props.uri }}
        resizeMode="contain"
        accessible={false}
        onLoad={(event) => {
          setLoaded(true);
          props.onLoad(event.nativeEvent.source);
        }}
        onError={props.onError}
        style={{ width: "100%", height: "100%", opacity: loaded ? 1 : 0 }}
      />
      {loaded ? null : (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}
        >
          <Text className="text-xs text-foreground-muted">Loading image…</Text>
        </View>
      )}
    </>
  );
}

/** Markdown image whose src is a workspace file — loads through a signed asset URL. */
function ThreadMarkdownImage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly path: string;
  readonly alt: string | null;
  readonly onPressImage: (uri: string) => void;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadId,
    path: props.path,
  });

  return (
    <ThreadMarkdownImageView
      uri={assetUrl._tag === "Success" ? assetUrl.url : null}
      sourceKey={props.path}
      unavailable={assetUrl._tag === "Failure"}
      alt={props.alt}
      onPressImage={props.onPressImage}
    />
  );
}

function ThreadMarkdownImageUnavailable(props: { readonly alt: string | null }) {
  return (
    <ThreadMarkdownImageView
      uri={null}
      sourceKey="unavailable"
      unavailable
      alt={props.alt}
      onPressImage={() => undefined}
    />
  );
}

const MARKDOWN_MONO_FONT = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});

interface MarkdownStyleSets {
  readonly user: MarkdownStyleSet;
  readonly assistant: MarkdownStyleSet;
}

interface MarkdownStyleSet {
  readonly theme: PartialMarkdownTheme;
  readonly styles: NodeStyleOverrides;
  readonly renderers: CustomRenderers;
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

interface ReviewCommentColors {
  readonly background: ColorValue;
  readonly border: ColorValue;
  readonly mutedBackground: ColorValue;
  readonly text: ColorValue;
  readonly mutedText: ColorValue;
  readonly codeBackground: ColorValue;
}

const failedMarkdownFaviconHosts = new Set<string>();
const markdownLinkStyles = StyleSheet.create({
  inlineIcon: {
    width: 14,
    height: 14,
    marginHorizontal: 3,
    transform: [{ translateY: 2 }],
  },
  favicon: {
    borderRadius: 3,
  },
});

const MarkdownExternalLink = memo(function MarkdownExternalLink(props: {
  readonly children: ReactNode;
  readonly color: string;
  readonly host: string;
  readonly href: string;
}) {
  const [failed, setFailed] = useState(() => failedMarkdownFaviconHosts.has(props.host));

  return (
    <NativeText
      className="font-sans"
      onPress={() => {
        void tryOpenExternalUrl(props.href, "markdown-link");
      }}
      style={{
        color: props.color,
        textDecorationLine: "none",
      }}
    >
      {!failed ? (
        <Image
          source={{
            uri: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(props.host)}&sz=32`,
          }}
          style={[markdownLinkStyles.inlineIcon, markdownLinkStyles.favicon]}
          onError={() => {
            failedMarkdownFaviconHosts.add(props.host);
            setFailed(true);
          }}
        />
      ) : (
        <NativeText style={{ color: props.color }}>{" ◉ "}</NativeText>
      )}
      {props.children}
    </NativeText>
  );
});

function MarkdownCodeBlock(props: {
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly content: string;
  readonly copyTintColor: ColorValue;
  readonly headerTextColor: string;
  readonly fontSize: number;
  readonly highlightCode: boolean;
  readonly language?: string | null;
  readonly lineHeight: number;
  readonly textColor: string;
  readonly theme: ReviewDiffTheme;
}) {
  const content = props.content.replace(/\n$/, "");
  const languageLabel = props.language?.trim() || "text";
  const highlighted = useMarkdownCodeHighlight({
    code: content,
    enabled: props.highlightCode && Boolean(props.language?.trim()),
    language: props.language,
    theme: props.theme,
  });
  let tokenOffset = 0;

  return (
    <View
      className="my-3 min-w-0 max-w-full self-stretch overflow-hidden rounded-lg border"
      style={{ backgroundColor: props.backgroundColor, borderColor: props.borderColor }}
    >
      <View
        className="flex-row items-center justify-between gap-2 border-b py-1 pr-1.5 pl-3.5"
        style={{ borderBottomColor: props.borderColor }}
      >
        <NativeText
          className="flex-1 font-mono uppercase opacity-70"
          numberOfLines={1}
          style={{
            color: props.headerTextColor,
            fontSize: props.fontSize,
            ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
          }}
        >
          {languageLabel}
        </NativeText>
        <CopyTextButton
          accessibilityLabel="Copy code"
          text={content}
          tintColor={props.copyTintColor}
          buttonSize={32}
          iconSize={16}
        />
      </View>
      <ScrollView
        horizontal
        bounces={false}
        nestedScrollEnabled={Platform.OS === "android"}
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="px-3.5 py-3"
      >
        <NativeText
          selectable
          className="font-mono"
          style={{
            color: props.textColor,
            fontSize: props.fontSize,
            lineHeight: props.lineHeight,
            ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
          }}
        >
          {highlighted
            ? highlighted.map((line, lineIndex) => {
                const lineStartOffset = tokenOffset;
                const lineText = line.map((token) => token.content).join("");
                const renderedLine = (
                  <NativeText key={`line:${lineStartOffset}:${lineText}`}>
                    {line.map((token) => {
                      const startOffset = tokenOffset;
                      tokenOffset += token.content.length;
                      const fontStyle =
                        token.fontStyle !== null && (token.fontStyle & 1) === 1
                          ? ("italic" as const)
                          : ("normal" as const);
                      const fontWeight =
                        token.fontStyle !== null && (token.fontStyle & 2) === 2
                          ? ("700" as const)
                          : ("400" as const);

                      return (
                        <NativeText
                          key={`${startOffset}:${token.content}:${token.color ?? ""}:${
                            token.fontStyle ?? ""
                          }`}
                          style={{
                            color: token.color ?? props.textColor,
                            fontStyle,
                            fontWeight,
                          }}
                        >
                          {token.content}
                        </NativeText>
                      );
                    })}
                    {lineIndex + 1 < highlighted.length ? "\n" : ""}
                  </NativeText>
                );
                if (lineIndex + 1 < highlighted.length) {
                  tokenOffset += 1;
                }
                return renderedLine;
              })
            : content}
        </NativeText>
      </ScrollView>
    </View>
  );
}

function useReviewCommentColors(): ReviewCommentColors {
  const background = useThemeColor("--color-card");
  const border = useThemeColor("--color-border");
  const mutedBackground = useThemeColor("--color-subtle");
  const text = useThemeColor("--color-foreground");
  const mutedText = useThemeColor("--color-foreground-muted");
  const codeBackground = useThemeColor("--color-md-code-bg");

  return useMemo(
    () => ({
      background,
      border,
      mutedBackground,
      text,
      mutedText,
      codeBackground,
    }),
    [background, border, codeBackground, mutedBackground, mutedText, text],
  );
}

function useMarkdownStyles(
  onLinkPress: (href: string) => void,
  renderImage: MarkdownImageRenderer,
): MarkdownStyleSets {
  const { appearance, themeAppearance } = useAppearancePreferences();
  const markdownFontSizes = useMemo(
    () => resolveMarkdownFontSizes(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const themeMode = themeAppearance;
  const markdownBodyColor = String(useThemeColor("--color-md-body"));
  const markdownStrongColor = String(useThemeColor("--color-md-strong"));
  const markdownLinkColor = String(useThemeColor("--color-md-link"));
  const markdownBlockquoteBg = String(useThemeColor("--color-md-blockquote-bg"));
  const markdownBlockquoteBorder = String(useThemeColor("--color-md-blockquote-border"));
  const markdownCodeBg = String(useThemeColor("--color-md-code-bg"));
  const markdownCodeText = String(useThemeColor("--color-md-code-text"));
  const markdownInlineCodeText = String(useThemeColor("--color-foreground-secondary"));
  const markdownHrColor = String(useThemeColor("--color-md-hr"));
  const markdownUserBodyColor = String(useThemeColor("--color-user-bubble-foreground"));
  const markdownUserCodeBg = String(useThemeColor("--color-md-user-code-bg"));
  const markdownUserCodeText = String(useThemeColor("--color-md-user-code-text"));
  const markdownUserInlineCodeText = String(useThemeColor("--color-user-bubble-foreground-muted"));
  const markdownUserFenceBg = String(useThemeColor("--color-md-user-fence-bg"));
  const markdownUserFenceText = String(useThemeColor("--color-md-user-fence-text"));
  const iconSubtleColor = String(useThemeColor("--color-icon-subtle"));
  const inlineSkillForeground = String(useThemeColor("--color-inline-skill-foreground"));
  const userBubbleSkillForeground = String(useThemeColor("--color-user-bubble-skill-foreground"));
  const userBubbleForegroundMuted = String(useThemeColor("--color-user-bubble-foreground-muted"));
  const regularFontFamily = useFontFamily("regular");
  const boldFontFamily = useFontFamily("bold");

  return useMemo(() => {
    const baseTheme: PartialMarkdownTheme = {
      colors: {
        text: markdownBodyColor,
        heading: markdownStrongColor,
        link: markdownLinkColor,
        blockquote: markdownBlockquoteBorder,
        border: markdownHrColor,
        surface: "transparent",
        surfaceLight: markdownBlockquoteBg,
        accent: markdownLinkColor,
        tableBorder: markdownHrColor,
        tableHeader: markdownBlockquoteBg,
        tableHeaderText: markdownStrongColor,
        tableRowOdd: "transparent",
        tableRowEven: "transparent",
      },
      spacing: {
        xs: 4,
        s: 4,
        m: 8,
        l: 8,
        xl: 16,
      },
      fontSizes: {
        s: markdownFontSizes.s,
        m: markdownFontSizes.m,
        h1: markdownFontSizes.h1,
        h2: markdownFontSizes.h2,
        h3: markdownFontSizes.h3,
        h4: markdownFontSizes.h4,
        h5: markdownFontSizes.h5,
        h6: markdownFontSizes.h6,
      },
      fontFamilies: {
        regular: regularFontFamily,
        heading: boldFontFamily,
        mono: MARKDOWN_MONO_FONT,
      },
      headingWeight: "700",
      borderRadius: {
        s: 4,
        m: 8,
        l: 12,
      },
      showCodeLanguage: false,
    };

    const baseStyles: NodeStyleOverrides = {
      document: { flexShrink: 1 },
      paragraph: { marginTop: 0, marginBottom: 10 },
      list: { marginTop: 4, marginBottom: 8 },
      list_item: { marginTop: 0, marginBottom: 4 },
      task_list_item: { marginTop: 0, marginBottom: 4 },
      text: { lineHeight: markdownFontSizes.bodyLineHeight },
      bold: {
        fontWeight: "700",
        color: markdownStrongColor,
        fontFamily: boldFontFamily,
      },
      italic: { fontStyle: "italic" },
      link: {
        color: markdownLinkColor,
        textDecorationLine: "underline" as const,
      },
      blockquote: {
        borderLeftWidth: 2,
        borderLeftColor: markdownBlockquoteBorder,
        paddingLeft: 11,
        paddingVertical: 2,
        marginLeft: 0,
        marginVertical: 10,
      },
      heading: {
        fontFamily: boldFontFamily,
        color: markdownStrongColor,
        marginTop: 18,
        marginBottom: 8,
      },
      horizontal_rule: {
        backgroundColor: markdownHrColor,
        height: 1,
        marginVertical: 12,
      },
    };

    const createMarkdownRenderers = (
      inlineTextColor: string,
      inlineCodeTextColor: string,
      blockBackgroundColor: string,
      blockTextColor: string,
      copyTintColor: ColorValue,
      preserveSoftBreaks: boolean,
      highlightCode: boolean,
    ): CustomRenderers => ({
      link: ({ children, href = "" }) => {
        const presentation = resolveMarkdownLinkPresentation(href);
        if (presentation.kind === "file") {
          return (
            <NativeText
              className="font-t3-bold"
              onPress={() => onLinkPress(href)}
              style={{ color: inlineTextColor }}
            >
              <Image
                source={markdownFileIconSource(presentation.icon)}
                style={markdownLinkStyles.inlineIcon}
              />
              {presentation.label}
            </NativeText>
          );
        }
        if (presentation.kind === "external") {
          return (
            <MarkdownExternalLink
              href={presentation.href}
              host={presentation.host}
              color={markdownLinkColor}
            >
              {children}
            </MarkdownExternalLink>
          );
        }
        const linkHref = presentation.href;
        return (
          <NativeText
            className="underline"
            onPress={
              linkHref
                ? () => {
                    void tryOpenExternalUrl(linkHref, "markdown-link");
                  }
                : undefined
            }
            style={{ color: markdownLinkColor }}
          >
            {children}
          </NativeText>
        );
      },
      list: ({ node, Renderer, ordered = false, start = 1 }) => (
        <View className="mt-0.5 mb-2">
          {node.children?.map((child, index) => {
            const childKey = `${child.type}:${child.beg ?? "unknown"}:${child.end ?? "unknown"}`;
            if (child.type === "task_list_item") {
              return (
                <Renderer key={childKey} node={child} depth={1} inListItem parentIsText={false} />
              );
            }
            return (
              <View className="mb-[3px] flex-row items-start" key={childKey}>
                <NativeText
                  className="font-sans"
                  style={{
                    width: ordered ? 22 : 12,
                    marginRight: 5,
                    color: inlineTextColor,
                    fontSize: markdownFontSizes.m,
                    lineHeight: markdownFontSizes.bodyLineHeight,
                    textAlign: ordered ? "right" : "center",
                  }}
                >
                  {ordered ? `${start + index}.` : "•"}
                </NativeText>
                <View className="min-w-0 flex-1">
                  <Renderer node={child} depth={1} inListItem parentIsText={false} />
                </View>
              </View>
            );
          })}
        </View>
      ),
      image: ({ node }) =>
        node.href
          ? (renderImage({
              href: node.href,
              alt: node.alt ?? null,
              title: node.title ?? null,
            }) ?? undefined)
          : undefined,
      code_inline: ({ content }) => {
        const value = content ?? "";
        return (
          <NativeText
            className="font-mono"
            style={{
              color: inlineCodeTextColor,
              fontSize: markdownFontSizes.codeBlockFontSize,
              lineHeight: markdownFontSizes.bodyLineHeight,
            }}
          >
            {value}
          </NativeText>
        );
      },
      ...(preserveSoftBreaks
        ? {
            soft_break: () => <NativeText>{"\n"}</NativeText>,
          }
        : {}),
      code_block: ({ content = "", language }) => (
        <MarkdownCodeBlock
          backgroundColor={blockBackgroundColor}
          borderColor={markdownHrColor}
          content={content}
          copyTintColor={copyTintColor}
          fontSize={markdownFontSizes.codeBlockFontSize}
          headerTextColor={blockTextColor}
          highlightCode={highlightCode}
          language={language}
          lineHeight={markdownFontSizes.codeBlockLineHeight}
          textColor={blockTextColor}
          theme={themeMode}
        />
      ),
    });

    const userTheme: PartialMarkdownTheme = {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        text: markdownUserBodyColor,
        heading: markdownUserBodyColor,
        link: markdownUserBodyColor,
        code: markdownUserCodeText,
        codeBackground: markdownUserCodeBg,
        border: markdownUserFenceBg,
      },
    };
    const userStyles: NodeStyleOverrides = {
      ...baseStyles,
      paragraph: { marginTop: 0, marginBottom: 0 },
      bold: {
        fontWeight: "700",
        color: markdownUserBodyColor,
        fontFamily: boldFontFamily,
      },
      heading: {
        ...baseStyles.heading,
        color: markdownUserBodyColor,
        marginTop: 8,
        marginBottom: 4,
      },
      link: {
        color: markdownUserBodyColor,
        textDecorationLine: "underline" as const,
      },
    };

    const assistantTheme: PartialMarkdownTheme = {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        code: markdownCodeText,
        codeBackground: markdownCodeBg,
        border: markdownCodeBg,
      },
    };
    const assistantStyles: NodeStyleOverrides = {
      ...baseStyles,
    };

    return {
      user: {
        theme: userTheme,
        styles: userStyles,
        renderers: createMarkdownRenderers(
          markdownUserCodeText,
          markdownUserInlineCodeText,
          markdownUserFenceBg,
          markdownUserFenceText,
          userBubbleForegroundMuted,
          true,
          false,
        ),
        nativeTextStyle: {
          color: markdownUserBodyColor,
          strongColor: markdownUserBodyColor,
          mutedColor: markdownUserBodyColor,
          linkColor: markdownUserBodyColor,
          inlineCodeColor: markdownUserInlineCodeText,
          codeColor: markdownUserCodeText,
          codeBackgroundColor: markdownUserCodeBg,
          codeBlockBackgroundColor: markdownUserFenceBg,
          fileTextColor: markdownUserBodyColor,
          skillTextColor: userBubbleSkillForeground,
          quoteMarkerColor: markdownUserBodyColor,
          dividerColor: markdownUserBodyColor,
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
        },
      },
      assistant: {
        theme: assistantTheme,
        styles: assistantStyles,
        renderers: createMarkdownRenderers(
          markdownCodeText,
          markdownInlineCodeText,
          markdownCodeBg,
          markdownCodeText,
          iconSubtleColor,
          false,
          true,
        ),
        nativeTextStyle: {
          color: markdownBodyColor,
          strongColor: markdownStrongColor,
          mutedColor: markdownBodyColor,
          linkColor: markdownLinkColor,
          inlineCodeColor: markdownInlineCodeText,
          codeColor: markdownCodeText,
          codeBackgroundColor: markdownCodeBg,
          codeBlockBackgroundColor: markdownCodeBg,
          fileTextColor: markdownCodeText,
          skillTextColor: inlineSkillForeground,
          quoteMarkerColor: markdownBlockquoteBorder,
          dividerColor: markdownHrColor,
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
        },
      },
    };
  }, [
    boldFontFamily,
    iconSubtleColor,
    inlineSkillForeground,
    markdownBlockquoteBg,
    markdownBlockquoteBorder,
    markdownBodyColor,
    markdownCodeBg,
    markdownCodeText,
    markdownFontSizes,
    markdownHrColor,
    markdownInlineCodeText,
    markdownLinkColor,
    markdownStrongColor,
    markdownUserBodyColor,
    markdownUserCodeBg,
    markdownUserCodeText,
    markdownUserFenceBg,
    markdownUserFenceText,
    markdownUserInlineCodeText,
    nativeMarkdownTypography,
    onLinkPress,
    regularFontFamily,
    renderImage,
    themeMode,
    userBubbleForegroundMuted,
    userBubbleSkillForeground,
  ]);
}

function renderFeedEntry(
  info: { item: ThreadFeedEntry; index: number },
  props: Pick<
    ThreadFeedProps,
    | "environmentId"
    | "threadId"
    | "skills"
    | "textToSpeechAvailable"
    | "textToSpeechPersistentJobs"
    | "messageSummariesAvailable"
    | "steerPendingMessageIds"
  > & {
    readonly getThreadTitle: () => string;
    readonly copiedRowId: string | null;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly settledTurnOpeningAssistantMessageIds: ReadonlySet<string>;
    readonly terminalAssistantMessageIds: ReadonlySet<string>;
    readonly unsettledTurnId: TurnId | null;
    readonly onCopyWorkRow: (rowId: string, value: string) => void;
    readonly onToggleWorkGroup: (groupId: string) => void;
    readonly onToggleWorkRow: (rowId: string) => void;
    readonly onToggleTurnFold: (turnId: TurnId) => void;
    readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
    readonly onMarkdownLinkPress: (href: string) => void;
    readonly renderMarkdownImage: MarkdownImageRenderer;
    readonly iconSubtleColor: string | import("react-native").ColorValue;
    readonly userBubbleColor: string | import("react-native").ColorValue;
    readonly markdownStyles: MarkdownStyleSets;
    readonly reviewCommentColors: ReviewCommentColors;
    readonly reviewCommentBubbleWidth: number;
    readonly userBubbleMaxWidth: number;
  },
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props;

  if (entry.type === "working") {
    return <WorkingTimelineRow startedAt={entry.createdAt} />;
  }

  if (entry.type === "turn-fold") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: entry.expanded }}
        onPress={() => props.onToggleTurnFold(entry.turnId)}
        hitSlop={4}
        className="mb-3 min-h-11 flex-row items-center gap-2 border-b border-neutral-200/80 px-2 dark:border-white/[0.08]"
      >
        <Text className="font-t3-medium text-sm tabular-nums text-foreground-muted">
          {entry.label}
        </Text>
        <SymbolView
          name={entry.expanded ? "chevron.down" : "chevron.right"}
          size={15}
          tintColor={iconSubtleColor}
          type="monochrome"
        />
      </Pressable>
    );
  }

  if (entry.type === "work-toggle") {
    return (
      <ThreadWorkGroupToggle
        expanded={entry.expanded}
        hiddenCount={entry.hiddenCount}
        iconSubtleColor={iconSubtleColor}
        onlyToolActivities={entry.onlyToolActivities}
        onToggle={() => props.onToggleWorkGroup(entry.groupId)}
      />
    );
  }

  if (entry.type === "message") {
    const { message } = entry;
    const isUser = message.role === "user";
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;
    const timestampLabel = formatMessageTime(isUser ? message.createdAt : message.updatedAt);
    const attachments = message.attachments ?? [];
    const hasReviewCommentContext = message.text.includes("<review_comment");
    // A bubble that sizes itself from its content cannot lay out a block whose
    // intrinsic width overflows `maxWidth`: Android positions the bubble's
    // children during the unclamped pass and never moves them once the width
    // is clamped, so the paragraphs around the block end up drawn on top of
    // each other. Pinning the width removes that pass.
    const hasWideBlock = hasWideMarkdownBlock(message.text, WIDE_MARKDOWN_BLOCK_OPTIONS);
    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      props.unsettledTurnId !== null &&
      message.turnId === props.unsettledTurnId;
    const showAssistantMeta =
      message.role === "assistant" &&
      (props.terminalAssistantMessageIds.has(message.id) ||
        props.settledTurnOpeningAssistantMessageIds.has(message.id)) &&
      !assistantTurnStillInProgress &&
      !message.streaming;

    if (isUser) {
      const enterAnimated = isFreshTimestamp(message.createdAt);
      const steerPending = props.steerPendingMessageIds?.has(message.id) === true;
      return (
        <Animated.View
          className="mb-5 items-end"
          {...(enterAnimated ? { entering: FadeInUp.duration(220) } : {})}
        >
          <View
            className="min-w-0 gap-2 rounded-[20px] px-3.5 py-2.5"
            style={{
              backgroundColor: userBubbleColor,
              maxWidth: props.userBubbleMaxWidth,
              ...(steerPending ? { opacity: 0.75 } : null),
              ...(hasReviewCommentContext
                ? { width: props.reviewCommentBubbleWidth }
                : hasWideBlock
                  ? { width: props.userBubbleMaxWidth }
                  : null),
            }}
          >
            {message.text.trim().length > 0 ? (
              <UserMessageContent
                text={message.text}
                markdownStyles={styles}
                reviewCommentColors={props.reviewCommentColors}
                skills={props.skills}
                onLinkPress={props.onMarkdownLinkPress}
                renderImage={props.renderMarkdownImage}
              />
            ) : null}
            {attachments.map((attachment) => {
              return (
                <MessageAttachmentImage
                  key={attachment.id}
                  environmentId={props.environmentId}
                  attachmentId={attachment.id}
                  className="aspect-[1.3] w-full rounded-[14px] bg-white/15"
                  onPressImage={props.onPressImage}
                />
              );
            })}
          </View>
          {steerPending ? <SteerPendingMarker tintColor={iconSubtleColor} /> : null}
          <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
            {message.inputOrigin === "voice-transcription" ? (
              <View className="flex-row items-center gap-1 pr-1">
                <SymbolView
                  name="mic.fill"
                  size={11}
                  tintColor={iconSubtleColor}
                  type="monochrome"
                />
                <Text className="font-t3-medium text-xs text-foreground-secondary">
                  Transcribed
                </Text>
              </View>
            ) : null}
            <Text className="font-t3-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
              {timestampLabel}
            </Text>
            {message.text.trim().length > 0 ? (
              <CopyTextButton
                accessibilityLabel="Copy message"
                text={message.text}
                tintColor={iconSubtleColor}
                buttonSize={28}
                iconSize={13}
              />
            ) : null}
          </View>
        </Animated.View>
      );
    }

    const agentVoiceReply = message.speech?.origin === "agent" ? message.speech : null;
    // Skip empty assistant messages (no text, no attachments, no voice
    // reply) — they would render as an orphaned timestamp and break adjacent
    // activity-group merging.
    if (message.text.trim().length === 0 && attachments.length === 0 && agentVoiceReply === null) {
      return null;
    }

    const enterAnimated = isFreshTimestamp(message.createdAt);
    const writtenReply =
      message.text.trim().length > 0 ? (
        hasNativeSelectableMarkdownText() ? (
          <SelectableMarkdownText
            markdown={message.text}
            skills={props.skills}
            textStyle={styles.nativeTextStyle}
            onLinkPress={props.onMarkdownLinkPress}
            renderImage={props.renderMarkdownImage}
          />
        ) : (
          <Markdown
            options={{ gfm: true }}
            renderers={styles.renderers}
            styles={styles.styles}
            theme={styles.theme}
          >
            {message.text}
          </Markdown>
        )
      ) : null;
    return (
      <Animated.View
        className={cn(showAssistantMeta ? "mb-5 px-1" : "mb-2 px-1")}
        {...(enterAnimated ? { entering: FadeIn.duration(220) } : {})}
      >
        {agentVoiceReply !== null ? (
          <AssistantAgentVoiceReply
            environmentId={props.environmentId}
            threadId={props.threadId}
            getThreadTitle={props.getThreadTitle}
            messageId={message.id}
            speech={agentVoiceReply}
            iconSubtleColor={iconSubtleColor}
            writtenReplyDuplicatesTranscript={
              message.text.trim() === agentVoiceReply.transcript.trim()
            }
          >
            {writtenReply}
          </AssistantAgentVoiceReply>
        ) : (
          writtenReply
        )}
        {attachments.map((attachment) => {
          return (
            <MessageAttachmentImage
              key={attachment.id}
              environmentId={props.environmentId}
              attachmentId={attachment.id}
              className="mt-1.5 aspect-[1.3] w-full rounded-[18px] bg-neutral-200 dark:bg-neutral-800"
              onPressImage={props.onPressImage}
            />
          );
        })}
        {showAssistantMeta ? (
          <AssistantMessageMetaAndArtifacts
            environmentId={props.environmentId}
            threadId={props.threadId}
            getThreadTitle={props.getThreadTitle}
            messageId={message.id}
            messageText={message.text}
            speechRequest={message.speechRequest ?? null}
            speechFailureReason={message.speechFailureReason}
            persistedSummary={message.generatedSummary ?? null}
            persistedSpeech={message.speech ?? null}
            timestampLabel={timestampLabel}
            iconSubtleColor={iconSubtleColor}
            textToSpeechAvailable={props.textToSpeechAvailable === true}
            textToSpeechPersistentJobs={props.textToSpeechPersistentJobs === true}
            messageSummariesAvailable={props.messageSummariesAvailable === true}
            markdownStyles={styles}
            skills={props.skills}
            onLinkPress={props.onMarkdownLinkPress}
            renderImage={props.renderMarkdownImage}
          />
        ) : null}
      </Animated.View>
    );
  }

  return (
    <ThreadWorkLog
      activities={entry.activities}
      copiedRowId={props.copiedRowId}
      expandedRows={props.expandedWorkRows}
      iconSubtleColor={iconSubtleColor}
      onCopyRow={props.onCopyWorkRow}
      onToggleRow={props.onToggleWorkRow}
    />
  );
}

/**
 * An agent-staged voice recording rendered as the message's main content:
 * player first, the written reply collapsed behind a toggle.
 */
function AssistantAgentVoiceReply(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly getThreadTitle: () => string;
  readonly messageId: MessageId;
  readonly speech: MessageSpeechSynthesisResult;
  readonly iconSubtleColor: ColorValue;
  /**
   * A voice-only turn's text is the transcript itself; the toggle is skipped
   * for it (the player's "View transcript" already covers it), but a dead
   * recording still forces the text visible — it is the message then.
   */
  readonly writtenReplyDuplicatesTranscript: boolean;
  readonly children: ReactNode;
}) {
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [writtenReplyExpanded, setWrittenReplyExpanded] = useState(false);
  // When the recording's file is gone, the written reply becomes the message
  // content and is forced visible instead of hiding behind the toggle.
  const [audioUnavailable, setAudioUnavailable] = useState(false);
  const onAudioUnavailable = useCallback(() => setAudioUnavailable(true), []);
  const hasWrittenReply = props.children !== null;

  return (
    <View>
      <AssistantSpeechPlayer
        environmentId={props.environmentId}
        threadId={props.threadId}
        getThreadTitle={props.getThreadTitle}
        messageId={props.messageId}
        speech={props.speech}
        iconSubtleColor={props.iconSubtleColor}
        transcriptExpanded={transcriptExpanded}
        onToggleTranscript={() => setTranscriptExpanded((current) => !current)}
        onRetry={null}
        onAudioUnavailable={onAudioUnavailable}
        primary
      />
      {hasWrittenReply && !props.writtenReplyDuplicatesTranscript && !audioUnavailable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: writtenReplyExpanded }}
          className="min-h-8 flex-row items-center gap-1 px-0.5"
          onPress={() => setWrittenReplyExpanded((current) => !current)}
        >
          <Text className="font-t3-medium text-xs text-foreground-muted">
            {writtenReplyExpanded ? "Hide written reply" : "Show written reply"}
          </Text>
          <SymbolView
            name={writtenReplyExpanded ? "chevron.up" : "chevron.down"}
            size={13}
            tintColor={props.iconSubtleColor}
            type="monochrome"
          />
        </Pressable>
      ) : null}
      {hasWrittenReply &&
      (audioUnavailable || (writtenReplyExpanded && !props.writtenReplyDuplicatesTranscript))
        ? props.children
        : null}
    </View>
  );
}

function AssistantMessageMetaAndArtifacts(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly getThreadTitle: () => string;
  readonly messageId: MessageId;
  readonly messageText: string;
  readonly speechRequest: MessageSpeechRequest | null;
  readonly speechFailureReason: MessageSpeechFailureReason | undefined;
  readonly persistedSummary: MessageSummaryResult | null;
  readonly persistedSpeech: MessageSpeechSynthesisResult | null;
  readonly timestampLabel: string;
  readonly iconSubtleColor: ColorValue;
  readonly textToSpeechAvailable: boolean;
  readonly textToSpeechPersistentJobs: boolean;
  readonly messageSummariesAvailable: boolean;
  readonly markdownStyles: MarkdownStyleSet;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly onLinkPress: (href: string) => void;
  readonly renderImage: MarkdownImageRenderer;
}) {
  const synthesize = useAtomCommand(synthesizeMessageSpeech, { reportFailure: false });
  const requestPersistentSpeech = useAtomCommand(threadEnvironment.requestMessageSpeech, {
    reportFailure: false,
  });
  const summarize = useAtomCommand(summarizeMessage, { reportFailure: false });
  const [legacyPreparing, setLegacyPreparing] = useState(false);
  // null = untouched: a row that already owns a recording starts expanded,
  // so returning to a thread still shows which messages have one.
  const [expandedState, setExpandedState] = useState<boolean | null>(null);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [summaryPreparing, setSummaryPreparing] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const readSessionArtifacts = useCallback(
    () =>
      getMessageArtifactSessionSnapshot(props.environmentId, props.messageId, props.messageText),
    [props.environmentId, props.messageId, props.messageText],
  );
  const sessionArtifacts = useSyncExternalStore(
    useCallback(
      (listener) => subscribeMessageArtifactSession(props.environmentId, props.messageId, listener),
      [props.environmentId, props.messageId],
    ),
    readSessionArtifacts,
    readSessionArtifacts,
  );
  const speech = props.textToSpeechPersistentJobs
    ? props.persistedSpeech
    : (sessionArtifacts.speech ?? props.persistedSpeech);
  const preparing = props.textToSpeechPersistentJobs
    ? props.speechRequest !== null
    : legacyPreparing;
  const summary = sessionArtifacts.summary ?? props.persistedSummary;
  // Agent voice replies render their own player above the message; the meta
  // row must not offer a second one (or a regeneration that would replace the
  // agent's recording with a synthesized listening version).
  const isAgentVoiceReply = speech !== null && speech.origin === "agent";
  const expanded = expandedState ?? speech !== null;
  const previousSpeechRequestId = useRef(props.speechRequest?.requestId);
  useEffect(() => {
    if (!props.textToSpeechPersistentJobs) return;
    const previousRequestId = previousSpeechRequestId.current;
    const currentRequestId = props.speechRequest?.requestId;
    previousSpeechRequestId.current = currentRequestId;
    if (previousRequestId === undefined || currentRequestId !== undefined) return;
    if (!consumeOwnedMessageSpeechRequest(previousRequestId)) return;
    if (speech !== null) {
      setExpandedState(true);
      return;
    }
    Alert.alert(
      "Listening version unavailable",
      messageSpeechFailureDescription(props.speechFailureReason),
    );
  }, [
    props.speechFailureReason,
    props.speechRequest?.requestId,
    props.textToSpeechPersistentJobs,
    speech,
  ]);

  const prepareSpeech = useCallback(async () => {
    if (preparing) return;
    if (props.textToSpeechPersistentJobs) {
      const result = await requestPersistentSpeech({
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          messageId: props.messageId,
        },
      });
      if (result._tag === "Success") return;
      Alert.alert(
        "Listening version unavailable",
        "T3 Code could not start audio preparation for this message. Try again.",
      );
      return;
    }

    setLegacyPreparing(true);
    const endRequest = beginMessageArtifactRequest(props.environmentId, props.messageId);
    try {
      const result = await synthesize({
        environmentId: props.environmentId,
        input: { messageId: props.messageId },
      });
      if (result._tag === "Success") {
        rememberMessageSpeech(props.environmentId, props.messageText, result.value);
        setExpandedState(true);
        return;
      }
      Alert.alert(
        "Listening version unavailable",
        "T3 Code could not prepare audio for this message. Try again in a moment.",
      );
    } finally {
      setLegacyPreparing(false);
      endRequest();
    }
  }, [
    preparing,
    props.environmentId,
    props.messageId,
    props.messageText,
    props.textToSpeechPersistentJobs,
    props.threadId,
    requestPersistentSpeech,
    synthesize,
  ]);

  const onPressSpeech = useCallback(async () => {
    if (speech !== null) {
      setExpandedState(!expanded);
      return;
    }
    await prepareSpeech();
  }, [expanded, prepareSpeech, speech]);

  const onPressSummary = useCallback(async () => {
    if (summary !== null) {
      setSummaryExpanded((current) => !current);
      return;
    }
    if (summaryPreparing) return;
    setSummaryPreparing(true);
    const endRequest = beginMessageArtifactRequest(props.environmentId, props.messageId);
    try {
      const result = await summarize({
        environmentId: props.environmentId,
        input: { messageId: props.messageId },
      });
      setSummaryPreparing(false);
      if (result._tag === "Success") {
        rememberMessageSummary(props.environmentId, props.messageText, result.value);
        setSummaryExpanded(true);
        return;
      }
      Alert.alert(
        "Summary unavailable",
        "T3 Code could not summarize this message. Try again in a moment.",
      );
    } finally {
      endRequest();
    }
  }, [
    props.environmentId,
    props.messageId,
    props.messageText,
    summarize,
    summary,
    summaryPreparing,
  ]);

  return (
    <View>
      <View className="mt-1 flex-row items-center gap-1">
        <CopyTextButton
          accessibilityLabel="Copy message"
          text={props.messageText}
          tintColor={props.iconSubtleColor}
          buttonSize={28}
          iconSize={13}
        />
        {(summary !== null || props.messageSummariesAvailable) &&
        props.messageText.trim().length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={summary === null ? "Create summary" : "Toggle summary"}
            accessibilityState={{
              expanded: summary === null ? undefined : summaryExpanded,
              busy: summaryPreparing,
            }}
            className="size-7 items-center justify-center rounded-lg active:bg-subtle-strong"
            disabled={summaryPreparing}
            hitSlop={8}
            onPress={() => void onPressSummary()}
          >
            {summaryPreparing ? (
              <ActivityIndicator size="small" color={props.iconSubtleColor} />
            ) : (
              <SymbolView
                name="doc.text"
                size={14}
                tintColor={props.iconSubtleColor}
                type="monochrome"
              />
            )}
          </Pressable>
        ) : null}
        {(props.textToSpeechAvailable || speech !== null) && !isAgentVoiceReply ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              speech === null ? "Create listening version" : "Toggle listening version"
            }
            accessibilityState={{
              expanded: speech === null ? undefined : expanded,
              busy: preparing,
            }}
            className="size-7 items-center justify-center rounded-lg active:bg-subtle-strong"
            disabled={preparing}
            hitSlop={8}
            onPress={() => void onPressSpeech()}
          >
            {preparing ? (
              <ActivityIndicator size="small" color={props.iconSubtleColor} />
            ) : (
              <SymbolView
                name="headphones"
                size={14}
                tintColor={props.iconSubtleColor}
                type="monochrome"
              />
            )}
          </Pressable>
        ) : null}
        <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
          {props.timestampLabel}
        </Text>
      </View>
      {summary !== null && summaryExpanded ? (
        <View className="mt-2 gap-2 rounded-2xl border border-border bg-subtle p-3">
          <View className="flex-row items-center gap-2">
            <SymbolView
              name="doc.text"
              size={14}
              tintColor={props.iconSubtleColor}
              type="monochrome"
            />
            <Text className="font-t3-bold text-xs text-foreground">Summary</Text>
          </View>
          {hasNativeSelectableMarkdownText() ? (
            <SelectableMarkdownText
              markdown={summary.summary}
              skills={props.skills}
              textStyle={props.markdownStyles.nativeTextStyle}
              onLinkPress={props.onLinkPress}
              renderImage={props.renderImage}
            />
          ) : (
            <Markdown
              options={{ gfm: true }}
              renderers={props.markdownStyles.renderers}
              styles={props.markdownStyles.styles}
              theme={props.markdownStyles.theme}
            >
              {summary.summary}
            </Markdown>
          )}
        </View>
      ) : null}
      {speech !== null && expanded && !isAgentVoiceReply ? (
        <AssistantSpeechPlayer
          environmentId={props.environmentId}
          threadId={props.threadId}
          getThreadTitle={props.getThreadTitle}
          messageId={props.messageId}
          speech={speech}
          iconSubtleColor={props.iconSubtleColor}
          transcriptExpanded={transcriptExpanded}
          onToggleTranscript={() => setTranscriptExpanded((current) => !current)}
          onRetry={() => void prepareSpeech()}
        />
      ) : null}
    </View>
  );
}

function AssistantSpeechPlayer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly getThreadTitle: () => string;
  readonly messageId: MessageId;
  readonly speech: MessageSpeechSynthesisResult;
  readonly iconSubtleColor: ColorValue;
  readonly transcriptExpanded: boolean;
  readonly onToggleTranscript: () => void;
  /** null hides the regenerate action (agent recordings cannot be re-made client-side). */
  readonly onRetry: (() => void) | null;
  /** Lets the row fall back to the written reply when the audio is gone. */
  readonly onAudioUnavailable?: () => void;
  /** Agent voice replies render the player as the message's main content. */
  readonly primary?: boolean;
}) {
  const { blocked, speed, track } = useListeningPlaybackSnapshot();
  // The transport sits on `bg-foreground`, so its glyph has to come from the
  // background family to stay legible. A literal white disappears on the light
  // `--color-foreground` that dark appearances and several built-in themes use.
  const onForegroundColor = useThemeColor("--color-sheet");
  const foregroundColor = String(useThemeColor("--color-foreground"));
  const { trackColor, outlineColor } = listeningPlayerChrome(foregroundColor);
  const audioUrlState = useAssetUrlState(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.speech.speechId,
  });
  const audioUrl = audioUrlState._tag === "Success" ? audioUrlState.url : null;
  // This row is a view over the app-scoped player: the recording keeps
  // playing when the row unmounts (thread switches, virtualization), and
  // remounting binds back to it. The MP3 is only fetched when the user
  // presses play — a thread can hold many recordings and the app may be on
  // a remote or cellular link.
  const isActiveTrack = track !== null && track.speechId === props.speech.speechId;
  const isPlaying = isActiveTrack && track.playing;
  // The play-before-URL intent lives in the controller, not this row: it
  // survives the row unmounting and starts once the signed URL lands. The
  // row only mirrors it for the loading spinner.
  const pendingSpeechId = usePendingListeningSpeechId();
  const audioUnavailable = audioUrlState._tag === "Failure";
  const onAudioUnavailableProp = props.onAudioUnavailable;
  useEffect(() => {
    if (audioUnavailable) onAudioUnavailableProp?.();
  }, [audioUnavailable, onAudioUnavailableProp]);

  const trackRef = useMemo<ListeningTrackRef>(
    () => ({
      environmentId: props.environmentId,
      threadId: props.threadId,
      messageId: props.messageId,
      speechId: props.speech.speechId,
    }),
    [props.environmentId, props.threadId, props.messageId, props.speech.speechId],
  );

  const speechId = props.speech.speechId;
  const environmentId = props.environmentId;
  const onTogglePlayback = useCallback(() => {
    if (isPlaying) {
      listeningPlayback.pauseActive();
      return;
    }
    if (blocked) return;
    requestListeningTrack({
      track: trackRef,
      metadata: { title: props.getThreadTitle() },
      url: audioUrl,
      watchUrl: (onResolved) =>
        watchAssetUrl(environmentId, { _tag: "attachment", attachmentId: speechId }, onResolved),
    });
  }, [audioUrl, blocked, environmentId, isPlaying, props.getThreadTitle, speechId, trackRef]);

  return (
    <View
      className={cn(
        "gap-2 rounded-2xl border border-border bg-subtle p-3",
        props.primary ? "mb-1" : "mt-2",
      )}
    >
      <View className="flex-row items-center gap-2">
        <SymbolView
          name="headphones"
          size={14}
          tintColor={props.iconSubtleColor}
          type="monochrome"
        />
        <Text className="font-t3-bold text-xs text-foreground">
          {props.primary ? "Voice reply" : "Listening version"}
        </Text>
      </View>
      {audioUrlState._tag === "Failure" ? (
        <View className="gap-2 py-1">
          <Text className="text-xs text-foreground-muted">
            {props.onRetry === null
              ? "The audio file is unavailable."
              : "The audio file is unavailable. Regenerate it to listen again."}
          </Text>
          {props.onRetry !== null ? (
            <Pressable accessibilityRole="button" className="min-h-8" onPress={props.onRetry}>
              <Text className="font-t3-medium text-xs text-foreground">Regenerate</Text>
            </Pressable>
          ) : null}
        </View>
      ) : audioUrl === null && pendingSpeechId === props.speech.speechId ? (
        <View className="flex-row items-center gap-2 py-1">
          <ActivityIndicator size="small" color={props.iconSubtleColor} />
          <Text className="text-xs text-foreground-muted">Loading audio…</Text>
        </View>
      ) : (
        <View className="gap-2">
          <View className="flex-row items-center gap-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                blocked
                  ? `Play ${props.primary ? "voice reply" : "listening version"} unavailable while recording`
                  : isPlaying
                    ? `Pause ${props.primary ? "voice reply" : "listening version"}`
                    : `Play ${props.primary ? "voice reply" : "listening version"}`
              }
              accessibilityState={{ disabled: blocked }}
              className={cn(
                "size-9 items-center justify-center rounded-full bg-foreground active:opacity-75",
                blocked && "opacity-50",
              )}
              disabled={blocked}
              onPress={onTogglePlayback}
            >
              <SymbolView
                name={isPlaying ? "pause.fill" : "play"}
                size={15}
                tintColor={onForegroundColor}
                type="monochrome"
              />
            </Pressable>
            {isActiveTrack ? (
              <ListeningTransportProgress trackColor={trackColor} />
            ) : (
              <View className="flex-1">
                <View
                  className="h-1.5 overflow-hidden rounded-full"
                  style={{ backgroundColor: trackColor }}
                />
              </View>
            )}
          </View>
          {blocked ? (
            <Text className="text-xs text-foreground-muted">Finish recording to listen.</Text>
          ) : null}
          <ListeningSpeedControl outlineColor={outlineColor} speed={speed} />
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.transcriptExpanded }}
        className="min-h-8 flex-row items-center gap-1"
        onPress={props.onToggleTranscript}
      >
        <Text className="font-t3-medium text-xs text-foreground-muted">
          {props.primary ? "View transcript" : "View listening transcript"}
        </Text>
        <SymbolView
          name={props.transcriptExpanded ? "chevron.up" : "chevron.down"}
          size={13}
          tintColor={props.iconSubtleColor}
          type="monochrome"
        />
      </Pressable>
      {props.transcriptExpanded ? (
        <Text className="text-sm leading-5 text-foreground-muted">{props.speech.transcript}</Text>
      ) : null}
    </View>
  );
}

/**
 * Live position for the loaded recording. Mounted only in the active row so
 * the player's 250ms progress tick never re-renders inactive players or the
 * feed around them.
 */
function ListeningTransportProgress(props: { readonly trackColor: string }) {
  const { currentTime, duration } = useListeningPlaybackProgress();
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <View className="flex-1 gap-1.5">
      <View
        className="h-1.5 overflow-hidden rounded-full"
        style={{ backgroundColor: props.trackColor }}
      >
        <View
          className="h-full rounded-full bg-foreground"
          style={{ width: `${progress * 100}%` }}
        />
      </View>
      <Text className="font-t3-medium text-[11px] tabular-nums text-foreground-muted">
        {formatListeningClock(currentTime)} / {formatListeningClock(duration)}
      </Text>
    </View>
  );
}

function ListeningSpeedControl(props: { readonly speed: number; readonly outlineColor: string }) {
  const speedActions = useMemo(
    () =>
      LISTENING_SPEED_PRESETS.map((preset) => ({
        id: String(preset),
        title: formatListeningSpeed(preset),
        state: preset === props.speed ? ("on" as const) : ("off" as const),
      })),
    [props.speed],
  );
  const spokenSpeed = listeningSpeedSpokenLabel(props.speed);

  return (
    <View
      accessibilityLabel="Playback speed"
      accessibilityRole="none"
      className="flex-row items-center justify-between gap-3"
    >
      <Text className="text-xs text-foreground-muted">Playback speed</Text>
      <View className="flex-row items-center gap-1">
        <Pressable
          accessibilityLabel="Decrease playback speed"
          accessibilityRole="button"
          accessibilityState={{ disabled: props.speed <= LISTENING_SPEED_MIN }}
          className="size-8 items-center justify-center rounded-lg active:bg-foreground/10 disabled:opacity-40"
          disabled={props.speed <= LISTENING_SPEED_MIN}
          hitSlop={6}
          onPress={() => listeningPlayback.nudgeSpeed(-1)}
        >
          <Text className="text-lg leading-5 text-foreground">−</Text>
        </Pressable>
        <ControlPillMenu
          accessibilityLabel={`Playback speed, ${spokenSpeed}. Choose preset.`}
          androidActionAccessibilityRole="radio"
          actions={speedActions}
          onPressAction={({ nativeEvent }) => listeningPlayback.setSpeed(Number(nativeEvent.event))}
        >
          <Pressable
            accessibilityLabel={`Playback speed, ${spokenSpeed}. Choose preset.`}
            accessibilityRole="button"
            className="h-8 min-w-16 items-center justify-center rounded-lg border px-2 active:bg-foreground/10"
            style={{ borderColor: props.outlineColor }}
          >
            <Text className="font-t3-bold text-xs tabular-nums text-foreground">
              {formatListeningSpeed(props.speed)}
            </Text>
          </Pressable>
        </ControlPillMenu>
        <Pressable
          accessibilityLabel="Increase playback speed"
          accessibilityRole="button"
          accessibilityState={{ disabled: props.speed >= LISTENING_SPEED_MAX }}
          className="size-8 items-center justify-center rounded-lg active:bg-foreground/10 disabled:opacity-40"
          disabled={props.speed >= LISTENING_SPEED_MAX}
          hitSlop={6}
          onPress={() => listeningPlayback.nudgeSpeed(1)}
        >
          <Text className="text-lg leading-5 text-foreground">+</Text>
        </Pressable>
      </View>
    </View>
  );
}
const WorkingTimelineRow = memo(function WorkingTimelineRow(props: { readonly startedAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => clearInterval(intervalId);
  }, [props.startedAt]);

  const durationLabel = formatElapsed(props.startedAt, new Date(nowMs).toISOString()) ?? "0s";

  return (
    <View className="mb-4 flex-row items-center gap-2 px-1.5 py-1">
      <View className="flex-row items-center gap-1">
        <View className="h-1 w-1 rounded-full bg-neutral-400 dark:bg-neutral-500" />
        <View className="h-1 w-1 rounded-full bg-neutral-400/80 dark:bg-neutral-500/80" />
        <View className="h-1 w-1 rounded-full bg-neutral-400/60 dark:bg-neutral-500/60" />
      </View>
      <Text className="font-t3-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
        Working for {durationLabel}
      </Text>
    </View>
  );
});

function UserMessageContent(props: {
  readonly text: string;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly onLinkPress: (href: string) => void;
  readonly renderImage: MarkdownImageRenderer;
}) {
  const segments = parseReviewCommentMessageSegments(props.text);
  const hasReviewComment = segments.some((segment) => segment.kind === "review-comment");
  if (!hasReviewComment) {
    if (hasNativeSelectableMarkdownText()) {
      return (
        <SelectableMarkdownText
          markdown={props.text}
          skills={props.skills}
          textStyle={props.markdownStyles.nativeTextStyle}
          preserveSoftBreaks
          onLinkPress={props.onLinkPress}
          renderImage={props.renderImage}
        />
      );
    }
    return (
      <Markdown
        options={{ gfm: true }}
        renderers={props.markdownStyles.renderers}
        styles={props.markdownStyles.styles}
        theme={props.markdownStyles.theme}
      >
        {props.text}
      </Markdown>
    );
  }

  return (
    <View className="w-full gap-2">
      {segments.map((segment) => {
        if (segment.kind === "review-comment") {
          return (
            <ReviewCommentCard
              key={segment.comment.id}
              comment={segment.comment}
              colors={props.reviewCommentColors}
            />
          );
        }

        const text = segment.text.trim();
        if (text.length === 0) {
          return null;
        }

        return hasNativeSelectableMarkdownText() ? (
          <SelectableMarkdownText
            key={segment.id}
            markdown={text}
            skills={props.skills}
            textStyle={props.markdownStyles.nativeTextStyle}
            preserveSoftBreaks
            onLinkPress={props.onLinkPress}
            renderImage={props.renderImage}
          />
        ) : (
          <Markdown
            key={segment.id}
            options={{ gfm: true }}
            renderers={props.markdownStyles.renderers}
            styles={props.markdownStyles.styles}
            theme={props.markdownStyles.theme}
          >
            {text}
          </Markdown>
        );
      })}
    </View>
  );
}

const ReviewCommentCard = memo(function ReviewCommentCard(props: {
  readonly comment: ReviewInlineComment;
  readonly colors: ReviewCommentColors;
}) {
  const { codeSurface, nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance: appearanceScheme, themeId } = useAppearancePreferences();
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const patch = useMemo(() => buildReviewCommentPatch(props.comment), [props.comment]);
  const parsedDiff = useMemo(
    () => buildReviewParsedDiff(patch, `thread-review-comment:${props.comment.id}`),
    [patch, props.comment.id],
  );
  const nativeReviewDiffData = useMemo(() => buildNativeReviewDiffData(parsedDiff), [parsedDiff]);
  const compactNativeRows = useMemo(
    () => nativeReviewDiffData.rows.filter((row) => row.kind !== "file"),
    [nativeReviewDiffData.rows],
  );
  const nativeReviewDiffTheme = useMemo(
    () => createNativeReviewDiffTheme(appearanceScheme, themeId),
    [appearanceScheme, themeId],
  );
  const nativeRowsJson = useMemo(() => JSON.stringify(compactNativeRows), [compactNativeRows]);
  const nativeThemeJson = useMemo(
    () => JSON.stringify(nativeReviewDiffTheme),
    [nativeReviewDiffTheme],
  );
  const nativeStyleJson = useMemo(
    () => JSON.stringify(nativeReviewDiffStyle),
    [nativeReviewDiffStyle],
  );
  const nativeDiffHeight = useMemo(
    () =>
      Math.min(
        360,
        Math.max(
          112,
          compactNativeRows.length * nativeReviewDiffStyle.rowHeight +
            nativeReviewDiffStyle.fileHeaderVerticalMargin,
        ),
      ),
    [compactNativeRows.length, nativeReviewDiffStyle],
  );
  const shouldRenderNativeDiff = NativeReviewDiffView != null && compactNativeRows.length > 0;

  return (
    <View
      className="w-full overflow-hidden rounded-[16px] border border-continuous"
      style={{
        backgroundColor: props.colors.background,
        borderColor: props.colors.border,
      }}
    >
      <View
        className="flex-row items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: props.colors.border }}
      >
        <View
          className="size-6 items-center justify-center rounded-[7px] border-continuous"
          style={{ backgroundColor: props.colors.mutedBackground }}
        >
          <SymbolView
            name="doc.text"
            size={13}
            tintColor={props.colors.mutedText}
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1">
          <Text
            className="font-mono text-xs"
            numberOfLines={1}
            style={{ color: props.colors.text }}
          >
            {compactFileName(props.comment.filePath)}
          </Text>
        </View>
      </View>
      {shouldRenderNativeDiff ? (
        <View
          className="border-t"
          collapsable={false}
          style={{
            backgroundColor: nativeReviewDiffTheme.background,
            borderColor: props.colors.border,
            height: nativeDiffHeight,
          }}
        >
          <NativeReviewDiffView
            collapsable={false}
            style={StyleSheet.absoluteFill}
            appearanceScheme={appearanceScheme}
            contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
            rowHeight={nativeReviewDiffStyle.rowHeight}
            rowsJson={nativeRowsJson}
            styleJson={nativeStyleJson}
            themeJson={nativeThemeJson}
          />
        </View>
      ) : props.comment.diff.trim().length > 0 ? (
        <ScrollView
          horizontal
          nestedScrollEnabled
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          bounces={false}
          className="border-t"
          style={{ backgroundColor: props.colors.codeBackground, borderColor: props.colors.border }}
          contentContainerStyle={{ padding: 10 }}
        >
          <NativeText
            selectable
            className="font-mono"
            style={{
              color: props.colors.text,
              fontSize: codeSurface.fontSize,
              lineHeight: codeSurface.rowHeight,
            }}
          >
            {props.comment.diff.trim()}
          </NativeText>
        </ScrollView>
      ) : null}
      {props.comment.text.length > 0 ? (
        <View className="border-t px-3 py-3" style={{ borderColor: props.colors.border }}>
          <Text selectable className="text-base leading-snug" style={{ color: props.colors.text }}>
            {props.comment.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

function buildReviewCommentPatch(comment: ReviewInlineComment): string {
  if ((comment.fenceLanguage ?? "diff") !== "diff") {
    return "";
  }
  const diff = comment.diff.trim();
  if (!diff) {
    return "";
  }

  if (diff.startsWith("diff --git ")) {
    return diff;
  }

  const normalizedPath = comment.filePath.replaceAll("\\", "/");
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    diff,
  ].join("\n");
}

function compactFileName(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const lastSlashIndex = normalized.lastIndexOf("/");
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
}

function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number;
  readonly detail: string;
  readonly horizontalPadding: number;
  readonly title: string;
  readonly topInset: number;
}) {
  return (
    <View
      style={{
        flex: 1,
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: props.horizontalPadding + 24,
      }}
    >
      <View className="max-w-[320px] items-center gap-2">
        <Text className="text-center font-t3-bold text-lg text-foreground">{props.title}</Text>
        <Text className="text-center text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      </View>
    </View>
  );
}

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const navigation = useNavigation();
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foldSettleFrameRef = useRef<number | null>(null);
  const foldSettleSecondFrameRef = useRef<number | null>(null);
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const headerMaterialVisibleRef = useRef(false);
  const lastContentInsetReportRef = useRef<ThreadFeedInsetReport | null>(null);
  const previousLatestTurnRef = useRef(props.latestTurn);
  const settledTurnOpeningAssistantMessageIdsRef = useRef<ReadonlySet<string>>(new Set());
  const userScrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadTitleRef = useRef(props.threadTitle);
  useEffect(() => {
    threadTitleRef.current = props.threadTitle;
  }, [props.threadTitle]);
  const getThreadTitle = useCallback(() => threadTitleRef.current, []);
  const { width: windowWidth } = useWindowDimensions();
  const { appearance } = useAppearancePreferences();
  const [viewportWidth, setViewportWidth] = useState(() =>
    props.layoutVariant === "split" ? 0 : windowWidth,
  );
  const [viewportHeight, setViewportHeight] = useState(0);
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  // Live-follow latch. LegendList's maintainScrollAtEnd alone re-pins the feed
  // whenever the viewport drifts back inside its geometric threshold, which
  // yanked users off history they were reading every time a stream chunk grew
  // a row. Follow breaks when the user scrolls up and away, and re-arms only
  // when the list actually returns to the end (or on send / thread switch).
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  const endFollowEnabledRef = useRef(true);
  // A "user scroll session" spans from drag start through the end of its
  // momentum; only motion inside a session can break follow, so MVCP
  // compensations and programmatic scrolls never strand a follower.
  const userScrollSessionRef = useRef(false);
  const setEndFollow = useCallback(
    (enabled: boolean) => {
      if (endFollowEnabledRef.current === enabled) {
        return;
      }
      endFollowEnabledRef.current = enabled;
      setEndFollowEnabled(enabled);
      props.onEndFollowEnabledChange?.(enabled);
    },
    [props.onEndFollowEnabledChange],
  );
  const transitionEndFollow = useCallback(
    (event: ThreadFeedLiveFollowEvent) => {
      setEndFollow(resolveThreadFeedLiveFollow(endFollowEnabledRef.current, event));
    },
    [setEndFollow],
  );
  const [interactionState, setInteractionState] = useState<{
    readonly copiedRowId: string | null;
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly expandedTurnIds: ReadonlySet<TurnId>;
  }>({
    copiedRowId: null,
    expandedWorkGroups: {},
    expandedWorkRows: {},
    expandedTurnIds: new Set(),
  });
  const { copiedRowId, expandedWorkGroups, expandedWorkRows, expandedTurnIds } = interactionState;
  const [expandedImage, setExpandedImage] = useState<{
    uri: string;
    headers?: Record<string, string>;
  } | null>(null);
  const horizontalPadding = props.layoutVariant === "split" ? 20 : 16;
  const contentHorizontalPadding = deriveCenteredContentHorizontalPadding({
    viewportWidth,
    maxContentWidth: props.contentMaxWidth ?? null,
    minimumPadding: horizontalPadding,
  });
  const contentWidth = Math.max(0, viewportWidth - contentHorizontalPadding * 2);
  const userBubbleMaxWidth = contentWidth * 0.85;
  const reviewCommentBubbleWidth = Math.min(Math.max(280, contentWidth * 0.85), contentWidth);
  const insets = useSafeAreaInsets();
  const topContentInset = props.contentTopInset ?? insets.top + IOS_NAV_BAR_HEIGHT;
  const bottomContentInset = props.contentBottomInset ?? 18;
  const usesNativeAutomaticInsets =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios";
  const initialContentInset = deriveThreadFeedInitialContentInset({
    platform: Platform.OS,
    usesNativeAutomaticInsets,
    bottomContentInset,
  });
  // With automatic insets the header inset lives in UIKit's adjustedContentInset,
  // which LegendList's JS anchoring math cannot see — it measures the anchored
  // end space from the scroll view's frame top. Fold the header height back into
  // the anchor offset or a just-sent message anchors underneath the header and
  // the oversized end space keeps maintainScrollAtEnd snapping away from earlier
  // messages. Read the context directly (useHeaderHeight throws outside a
  // header-providing screen) and fall back to the standard iOS bar height.
  const navigationHeaderHeight = useContext(HeaderHeightContext);
  const anchorTopInset = usesNativeAutomaticInsets
    ? navigationHeaderHeight || insets.top + IOS_NAV_BAR_HEIGHT
    : topContentInset;

  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const userBubbleColor = useThemeColor("--color-user-bubble");
  const onMarkdownLinkPress = useCallback(
    (href: string) => {
      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        const relativePath = resolveWorkspaceRelativeFilePath(
          props.workspaceRoot,
          presentation.path,
        );
        if (relativePath) {
          void Haptics.selectionAsync();
          navigation.navigate("ThreadFile", {
            environmentId: String(props.environmentId),
            threadId: String(props.threadId),
            path: relativePath.split("/").filter((segment) => segment.length > 0),
            ...(presentation.line ? { line: String(presentation.line) } : {}),
          });
        }
        return;
      }

      if (presentation.href) {
        void tryOpenExternalUrl(presentation.href, "markdown-link");
      }
    },
    [props.environmentId, props.threadId, props.workspaceRoot, navigation],
  );
  const renderMarkdownImage = useCallback<MarkdownImageRenderer>(
    (image) => {
      const imageSource = classifyMarkdownImageSource(image.href, props.workspaceRoot ?? null);
      if (imageSource._tag === "Direct") {
        return (
          <ThreadMarkdownImageView
            uri={imageSource.uri}
            sourceKey={imageSource.uri}
            unavailable={false}
            alt={image.alt}
            onPressImage={(uri) => setExpandedImage({ uri })}
          />
        );
      }
      if (imageSource._tag === "Blocked") {
        return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      }
      return (
        <ThreadMarkdownImage
          environmentId={props.environmentId}
          threadId={props.threadId}
          path={imageSource.path}
          alt={image.alt}
          onPressImage={(uri) => setExpandedImage({ uri })}
        />
      );
    },
    [props.environmentId, props.threadId, props.workspaceRoot],
  );
  const markdownStyles = useMarkdownStyles(onMarkdownLinkPress, renderMarkdownImage);
  const reviewCommentColors = useReviewCommentColors();
  // LegendList does not invalidate visible rows when only the renderItem closure changes.
  // Keep row-local interaction props in extraData so disclosures and copy feedback repaint.
  const listAppearanceData = useMemo(
    () => ({
      copiedRowId,
      expandedWorkRows,
      iconSubtleColor,
      markdownStyles,
      reviewCommentColors,
      messageSummariesAvailable: props.messageSummariesAvailable,
      textToSpeechAvailable: props.textToSpeechAvailable,
      textToSpeechPersistentJobs: props.textToSpeechPersistentJobs,
      userBubbleColor,
      viewportWidth,
    }),
    [
      copiedRowId,
      expandedWorkRows,
      iconSubtleColor,
      markdownStyles,
      reviewCommentColors,
      props.messageSummariesAvailable,
      props.textToSpeechAvailable,
      props.textToSpeechPersistentJobs,
      userBubbleColor,
      viewportWidth,
    ],
  );
  const reportHeaderMaterialVisibility = useCallback(
    (visible: boolean) => {
      if (headerMaterialVisibleRef.current === visible) {
        return;
      }
      headerMaterialVisibleRef.current = visible;
      props.onHeaderMaterialVisibilityChange?.(visible);
    },
    [props.onHeaderMaterialVisibilityChange],
  );
  // Older-message paging. The latch stops a burst of scroll events from asking
  // for the same page repeatedly: `loadingOlderMessages` only turns true once
  // the request has been accepted, a frame or more later.
  const historyWindow = props.historyWindow;
  const olderPageRequestedRef = useRef(false);
  const contentHeightRef = useRef(Number.POSITIVE_INFINITY);
  const previousUnderfilledHistoryEffectRef = useRef({
    threadId: props.threadId,
    error: historyWindow?.error ?? null,
    viewportHeight,
  });
  const oldestFeedEntryId = props.feed[0]?.id ?? null;
  const previousRequestSignalsRef = useRef({
    oldestFeedEntryId,
    loadingOlderMessages: historyWindow?.loadingOlderMessages ?? false,
    settledCount: historyWindow?.settledCount ?? 0,
  });
  useEffect(() => {
    // Release once a page lands, loading changes, or any request attempt
    // settles. `settledCount` advances even for a disconnected rejection that
    // React batches into a single commit, so repeated failures and a later
    // warm resume cannot leave this mount's request latch stuck.
    const current = {
      oldestFeedEntryId,
      loadingOlderMessages: historyWindow?.loadingOlderMessages ?? false,
      settledCount: historyWindow?.settledCount ?? 0,
    };
    if (shouldReleaseOlderMessagesRequest(previousRequestSignalsRef.current, current)) {
      olderPageRequestedRef.current = false;
    }
    previousRequestSignalsRef.current = current;
  }, [oldestFeedEntryId, historyWindow?.loadingOlderMessages, historyWindow?.settledCount]);

  const requestOlderMessagesIfNeeded = useCallback(
    (distanceFromTop: number) => {
      if (
        historyWindow &&
        shouldRequestOlderMessages({
          distanceFromTop,
          hasOlderMessages: historyWindow.hasOlderMessages,
          loadingOlderMessages: historyWindow.loadingOlderMessages,
          requestInFlight: olderPageRequestedRef.current,
        })
      ) {
        olderPageRequestedRef.current = true;
        historyWindow.onLoadOlderMessages();
      }
    },
    [historyWindow],
  );
  const requestOlderMessagesForUnderfilledFeed = useCallback(
    (contentHeight: number) => {
      if (
        historyWindow &&
        shouldRequestOlderMessagesForUnderfilledFeed({
          contentHeight,
          viewportHeight,
          error: historyWindow.error,
          hasOlderMessages: historyWindow.hasOlderMessages,
          loadingOlderMessages: historyWindow.loadingOlderMessages,
          requestInFlight: olderPageRequestedRef.current,
        })
      ) {
        olderPageRequestedRef.current = true;
        // Underfill recovery is the app paging on the user's behalf, so it
        // observes the resident-message ceiling.
        historyWindow.onLoadOlderMessages({ automatic: true });
      }
    },
    [historyWindow, viewportHeight],
  );
  useEffect(() => {
    const previous = previousUnderfilledHistoryEffectRef.current;
    const current = {
      threadId: props.threadId,
      contentHeight: contentHeightRef.current,
      viewportHeight,
      error: historyWindow?.error ?? null,
      hasOlderMessages: historyWindow?.hasOlderMessages ?? false,
      loadingOlderMessages: historyWindow?.loadingOlderMessages ?? false,
      requestInFlight: olderPageRequestedRef.current,
    };
    previousUnderfilledHistoryEffectRef.current = {
      threadId: current.threadId,
      error: current.error,
      viewportHeight: current.viewportHeight,
    };

    const action = decideThreadUnderfilledHistoryEffectAction(previous, current);
    if (action === "reset-content-height") {
      contentHeightRef.current = Number.POSITIVE_INFINITY;
      olderPageRequestedRef.current = false;
      return;
    }
    if (action === "request-older-messages" && historyWindow) {
      // A short feed may not emit another content-size event after its parent
      // first becomes measurable or readiness clears a disconnected error.
      // Other settlements wait for user input or a measured size change.
      olderPageRequestedRef.current = true;
      // Automatic for the same reason as the callback above.
      historyWindow.onLoadOlderMessages({ automatic: true });
    }
  }, [historyWindow, props.threadId, viewportHeight]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // anchorTopInset, not topContentInset: under automatic insets the list
      // rests at contentOffset.y = -headerHeight (the inset lives only in
      // UIKit's adjustedContentInset, so topContentInset is 0 here). Add the
      // header height back or the material toggles a full header too late.
      reportHeaderMaterialVisibility(event.nativeEvent.contentOffset.y + anchorTopInset > 6);
      const { contentOffset } = event.nativeEvent;
      requestOlderMessagesIfNeeded(
        distanceFromFeedTop({
          contentOffsetY: contentOffset.y,
          topInset: anchorTopInset,
        }),
      );

      // LegendList recomputes its inset-aware end distance before invoking
      // this handler. Only the actual end re-arms follow; a live user-scroll
      // session still wins while automatic paging continues near the top.
      const listState = props.listRef.current?.getState();
      if (listState) {
        transitionEndFollow({
          type: "scroll",
          isAtEnd: listState.isAtEnd,
          userScrollSessionActive: userScrollSessionRef.current,
        });
      }
    },
    [
      anchorTopInset,
      props.listRef,
      reportHeaderMaterialVisibility,
      requestOlderMessagesIfNeeded,
      transitionEndFollow,
    ],
  );
  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeightRef.current = height;
      requestOlderMessagesForUnderfilledFeed(height);
    },
    [requestOlderMessagesForUnderfilledFeed],
  );
  const clearUserScrollSettle = useCallback(() => {
    if (userScrollSettleTimerRef.current !== null) {
      clearTimeout(userScrollSettleTimerRef.current);
      userScrollSettleTimerRef.current = null;
    }
  }, []);
  const handleScrollBeginDrag = useCallback(() => {
    clearUserScrollSettle();
    userScrollSessionRef.current = true;
    // Pause before the first scroll event. Otherwise a stream update can run
    // maintainScrollAtEnd between touch-down and the drag leaving its threshold.
    transitionEndFollow({ type: "user-scroll-begin" });
  }, [clearUserScrollSettle, transitionEndFollow]);
  const finishUserScroll = useCallback(
    (releaseIsAtEnd?: boolean) => {
      clearUserScrollSettle();
      const userScrollSessionActive = userScrollSessionRef.current;
      userScrollSessionRef.current = false;
      transitionEndFollow({
        type: "user-scroll-end",
        // With no momentum, preserve the finger-release position. Streaming
        // growth during the native momentum-detection window must not turn a
        // release at the live edge into an opt-out from follow.
        isAtEnd: releaseIsAtEnd ?? props.listRef.current?.getState().isAtEnd ?? false,
        userScrollSessionActive,
      });
    },
    [clearUserScrollSettle, props.listRef, transitionEndFollow],
  );
  // Finger-lift velocity is not a reliable momentum signal: a gentle fling
  // can report zero and still decelerate. Give native momentum a short window
  // to announce itself; if it does, onMomentumScrollBegin cancels this fallback
  // and the session survives until the settled momentum-end position. This
  // mirrors the native-event handoff used by the home thread list's scroll gate.
  const handleScrollEndDrag = useCallback(() => {
    clearUserScrollSettle();
    const releaseIsAtEnd = props.listRef.current?.getState().isAtEnd ?? false;
    userScrollSettleTimerRef.current = setTimeout(() => finishUserScroll(releaseIsAtEnd), 160);
  }, [clearUserScrollSettle, finishUserScroll, props.listRef]);
  const handleMomentumScrollBegin = useCallback(() => {
    if (userScrollSessionRef.current) {
      clearUserScrollSettle();
    }
  }, [clearUserScrollSettle]);
  const handleMomentumScrollEnd = useCallback(() => {
    finishUserScroll();
  }, [finishUserScroll]);

  useEffect(() => clearUserScrollSettle, [clearUserScrollSettle]);

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
    setViewportHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
  }, []);

  // Thread identity is env-scoped: two environments can hold the same
  // ThreadId, and keying resets (or the list mount) on the bare id would
  // carry stale scroll/follow state across an environment switch.
  const feedThreadKey = scopedThreadKey(props.environmentId, props.threadId);

  useEffect(() => {
    reportHeaderMaterialVisibility(false);
  }, [feedThreadKey, reportHeaderMaterialVisibility]);

  // A thread switch opens pinned to the end; a send explicitly returns to the
  // live edge (ThreadDetailScreen scrolls the new message into place). Both
  // re-arm follow regardless of where the user had scrolled before.
  useEffect(() => {
    clearUserScrollSettle();
    userScrollSessionRef.current = false;
    transitionEndFollow({ type: "reset" });
  }, [clearUserScrollSettle, feedThreadKey, transitionEndFollow]);
  useEffect(() => {
    if (props.submittedMessageId !== null) {
      clearUserScrollSettle();
      userScrollSessionRef.current = false;
      transitionEndFollow({ type: "reset" });
    }
  }, [clearUserScrollSettle, props.submittedMessageId, transitionEndFollow]);

  const expandedWorkGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [groupId, expanded] of Object.entries(expandedWorkGroups)) {
      if (expanded) {
        ids.add(groupId);
      }
    }
    return ids;
  }, [expandedWorkGroups]);
  const presentationState = useMemo(
    () =>
      deriveThreadFeedPresentationState(
        props.feed,
        props.latestTurn,
        expandedTurnIds,
        expandedWorkGroupIds,
        props.activeWorkStartedAt,
      ),
    [
      expandedTurnIds,
      expandedWorkGroupIds,
      props.activeWorkStartedAt,
      props.feed,
      props.latestTurn,
    ],
  );
  const presentedFeed = presentationState.entries;
  const derivedSettledTurnOpeningAssistantMessageIds =
    presentationState.settledTurnOpeningAssistantMessageIds;
  if (
    !haveSameStringSet(
      settledTurnOpeningAssistantMessageIdsRef.current,
      derivedSettledTurnOpeningAssistantMessageIds,
    )
  ) {
    settledTurnOpeningAssistantMessageIdsRef.current = derivedSettledTurnOpeningAssistantMessageIds;
  }
  const settledTurnOpeningAssistantMessageIds = settledTurnOpeningAssistantMessageIdsRef.current;
  const feedAppearanceData = useMemo(
    () => ({ listAppearanceData, settledTurnOpeningAssistantMessageIds }),
    [listAppearanceData, settledTurnOpeningAssistantMessageIds],
  );

  // The empty↔filled key below remounts the list, which resets its imperative
  // content-inset override — and useKeyboardChatComposerInset (mounted above
  // the remount boundary) deduplicates by height, so it never re-reports the
  // composer inset to the fresh instance. Re-report the measured overlay height
  // (composer plus any pending approval / user-input card) before the fresh
  // instance's first positioning tick; on Android the declarative contentInset
  // floor below covers the window before this effect lands. The baseline
  // resolver then keeps anchors, keyboard state, and measured composer changes
  // in sync.
  const listMountKey = `${feedThreadKey}:${props.feed.length === 0 ? "empty" : "filled"}`;
  useLayoutEffect(() => {
    const bottom = props.contentInsetEndAdjustment.value;
    if (bottom > 0) {
      props.listRef.current?.reportContentInset({ bottom });
    }
  }, [listMountKey, props.contentInsetEndAdjustment, props.listRef]);

  const anchoredEndSpace = useMemo(() => {
    const resolved = resolveChatListAnchoredEndSpace(
      presentedFeed,
      props.anchorMessageId,
      (entry) => (entry.type === "message" && entry.message.role === "user" ? entry.id : null),
      { anchorOffset: anchorTopInset + CHAT_LIST_ANCHOR_OFFSET },
    );
    const anchorMessageId = props.anchorMessageId;
    if (resolved === undefined || anchorMessageId === null) {
      return resolved;
    }

    return {
      ...resolved,
      onReady: (info: { readonly anchorKey: string | undefined; readonly size: number }) => {
        if (
          shouldReleaseThreadFeedAnchor({
            anchorMessageId,
            readyAnchorKey: info.anchorKey,
            readySize: info.size,
          })
        ) {
          props.onAnchorEndSpaceConsumed(anchorMessageId);
        }
      },
    };
  }, [anchorTopInset, presentedFeed, props.anchorMessageId, props.onAnchorEndSpaceConsumed]);

  // Re-report the measured closed-keyboard baseline to each list mount before
  // its first positioning tick, and again when the floating composer changes
  // height. The keyboard integration owns the override whenever the keyboard
  // or an anchored end space is in play — see resolveThreadFeedInsetReport.
  useLayoutEffect(() => {
    const report = resolveThreadFeedInsetReport({
      listMountKey,
      baseline: props.contentInsetBaseline,
      keyboardVisible: props.keyboardVisible,
      anchoredEndSpaceActive: anchoredEndSpace !== undefined,
      lastReported: lastContentInsetReportRef.current,
    });
    if (report === null) {
      return;
    }

    const list = props.listRef.current;
    if (list === null) {
      return;
    }

    list.reportContentInset({ bottom: report.baseline });
    lastContentInsetReportRef.current = report;
  }, [
    anchoredEndSpace,
    listMountKey,
    props.contentInsetBaseline,
    props.keyboardVisible,
    props.listRef,
  ]);
  const terminalAssistantMessageIds = useMemo(() => {
    const terminalIdsByTurn = new Map<TurnId, string>();
    for (const entry of props.feed) {
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {
        terminalIdsByTurn.set(entry.message.turnId, entry.message.id);
      }
    }
    return new Set(terminalIdsByTurn.values());
  }, [props.feed]);
  const unsettledTurnId =
    props.latestTurn &&
    (props.latestTurn.completedAt === null || props.latestTurn.state === "running")
      ? props.latestTurn.turnId
      : null;

  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = props.latestTurn;
    if (!props.latestTurn || !previous) {
      return;
    }
    if (props.latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && props.latestTurn.state === "interrupted") {
        const interruptedTurnId = props.latestTurn.turnId;
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(interruptedTurnId),
        }));
      }
      return;
    }
    setInteractionState((current) => {
      if (!current.expandedTurnIds.has(previous.turnId)) {
        return current;
      }
      const next = new Set(current.expandedTurnIds);
      next.delete(previous.turnId);
      return { ...current, expandedTurnIds: next };
    });
  }, [props.latestTurn]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
      if (foldSettleFrameRef.current !== null) {
        cancelAnimationFrame(foldSettleFrameRef.current);
      }
      if (foldSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(foldSettleSecondFrameRef.current);
      }
    };
  }, []);

  const suspendEndScrollMaintenanceForDisclosure = useCallback((anchorKey: string | null) => {
    disclosureAnchorKeyRef.current = anchorKey;
    setDisclosureToggleSettling(true);
    if (foldSettleFrameRef.current !== null) {
      cancelAnimationFrame(foldSettleFrameRef.current);
    }
    if (foldSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(foldSettleSecondFrameRef.current);
    }
    foldSettleFrameRef.current = requestAnimationFrame(() => {
      foldSettleSecondFrameRef.current = requestAnimationFrame(() => {
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        foldSettleFrameRef.current = null;
        foldSettleSecondFrameRef.current = null;
      });
    });
  }, []);

  const shouldRestoreVisibleContentPosition = useCallback((entry: ThreadFeedEntry) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || entry.id === disclosureAnchorKey;
  }, []);

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );

  const onCopyWorkRow = useCallback((rowId: string, value: string) => {
    copyTextWithHaptic(value, {
      target: "thread-work-row",
      feedback: "selection",
    });
    setInteractionState((current) => ({ ...current, copiedRowId: rowId }));
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setInteractionState((current) =>
        current.copiedRowId === rowId ? { ...current, copiedRowId: null } : current,
      );
      copyFeedbackTimeoutRef.current = null;
    }, 1200);
  }, []);

  const onToggleWorkGroup = useCallback(
    (groupId: string) => {
      suspendEndScrollMaintenanceForDisclosure(`work-toggle:${groupId}`);
      setInteractionState((current) => ({
        ...current,
        expandedWorkGroups: {
          ...current.expandedWorkGroups,
          [groupId]: !(current.expandedWorkGroups[groupId] ?? false),
        },
      }));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleWorkRow = useCallback(
    (rowId: string) => {
      suspendEndScrollMaintenanceForDisclosure(rowId);
      setInteractionState((current) => ({
        ...current,
        expandedWorkRows: {
          ...current.expandedWorkRows,
          [rowId]: !(current.expandedWorkRows[rowId] ?? false),
        },
      }));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleTurnFold = useCallback(
    (turnId: TurnId) => {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${turnId}`);
      setInteractionState((current) => {
        const next = new Set(current.expandedTurnIds);
        if (next.has(turnId)) {
          next.delete(turnId);
        } else {
          next.add(turnId);
        }
        return { ...current, expandedTurnIds: next };
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onPressImage = useCallback((uri: string, headers?: Record<string, string>) => {
    setExpandedImage({ uri, headers });
  }, []);

  // Rows whose height is known before they ever render. Without this, every
  // row above the viewport is assumed to be estimatedItemSize tall, and
  // scrolling up through unmeasured content corrects each row's height as it
  // mounts — the feed visibly jumps. Fixed sizes make the small chrome rows
  // exact; message rows stay undefined and use LegendList's per-type running
  // average once one of their type has been measured. Text-driven heights
  // follow the configurable base font size via scaledTypographyLineHeight.
  const workingRowHeight =
    WORKING_ROW_VERTICAL_EXTRAS +
    scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.label, appearance.baseFontSize);
  const getFixedItemSize = useCallback(
    (entry: ThreadFeedEntry) => {
      switch (entry.type) {
        case "turn-fold":
          return TURN_FOLD_HEIGHT;
        case "work-toggle":
          return WORK_GROUP_TOGGLE_HEIGHT;
        case "working":
          return workingRowHeight;
        case "activity-group":
          // Expanded rows append a variable detail block — fall back to
          // measurement for those groups.
          return entry.activities.some((activity) => expandedWorkRows[activity.id])
            ? undefined
            : collapsedWorkLogHeight(entry.activities, appearance.baseFontSize);
        default:
          return undefined;
      }
    },
    [expandedWorkRows, workingRowHeight, appearance.baseFontSize],
  );

  const renderItem = useCallback(
    (info: { item: ThreadFeedEntry; index: number }) =>
      renderFeedEntry(info, {
        environmentId: props.environmentId,
        threadId: props.threadId,
        getThreadTitle,
        messageSummariesAvailable: props.messageSummariesAvailable,
        textToSpeechAvailable: props.textToSpeechAvailable,
        textToSpeechPersistentJobs: props.textToSpeechPersistentJobs,
        steerPendingMessageIds: props.steerPendingMessageIds,
        copiedRowId,
        expandedWorkRows,
        settledTurnOpeningAssistantMessageIds,
        terminalAssistantMessageIds,
        unsettledTurnId,
        onCopyWorkRow,
        onToggleWorkGroup,
        onToggleWorkRow,
        onToggleTurnFold,
        onPressImage,
        onMarkdownLinkPress,
        renderMarkdownImage,
        iconSubtleColor,
        userBubbleColor,
        markdownStyles,
        reviewCommentColors,
        reviewCommentBubbleWidth,
        userBubbleMaxWidth,
        skills: props.skills,
      }),
    [
      copiedRowId,
      expandedWorkRows,
      settledTurnOpeningAssistantMessageIds,
      terminalAssistantMessageIds,
      unsettledTurnId,
      iconSubtleColor,
      userBubbleColor,
      markdownStyles,
      reviewCommentColors,
      reviewCommentBubbleWidth,
      userBubbleMaxWidth,
      getThreadTitle,
      onCopyWorkRow,
      onMarkdownLinkPress,
      onPressImage,
      onToggleTurnFold,
      onToggleWorkGroup,
      onToggleWorkRow,
      props.environmentId,
      props.messageSummariesAvailable,
      props.textToSpeechAvailable,
      props.textToSpeechPersistentJobs,
      props.threadId,
      props.steerPendingMessageIds,
      props.skills,
      renderMarkdownImage,
    ],
  );

  if (props.contentPresentation.kind === "unavailable") {
    return (
      <ThreadFeedPlaceholder
        title={props.contentPresentation.title}
        detail={props.contentPresentation.detail}
        topInset={topContentInset}
        bottomInset={bottomContentInset}
        horizontalPadding={horizontalPadding}
      />
    );
  }

  return (
    <>
      <View className="flex-1" onLayout={handleViewportLayout}>
        <View className="flex-1">
          <KeyboardAwareLegendList
            ref={props.listRef}
            // The empty↔filled key remounts the list when messages first
            // arrive. LegendList's maintainScrollAtEnd calls scrollToEnd(),
            // which is blind to UIKit's adjustedContentInset — inserting into
            // an already-attached list under a transparent header can pin
            // short content at offset 0 (one header-height too high). A fresh
            // mount positions during attach, where UIKit applies the inset.
            key={listMountKey}
            style={{ flex: 1 }}
            // RN 0.81+ drops touches inside the contentInset area
            // (facebook/react-native#54123); the anchored end space after a send
            // is pure inset, so without this the blank region can't be scrolled.
            applyWorkaroundForContentInsetHitTestBug
            contentInsetAdjustmentBehavior={usesNativeAutomaticInsets ? "automatic" : "never"}
            automaticallyAdjustsScrollIndicatorInsets={usesNativeAutomaticInsets}
            {...(usesNativeAutomaticInsets
              ? {
                  // Do NOT pass a manual `contentInset` here. Like the Home
                  // ScrollView, we rely purely on `contentInsetAdjustmentBehavior:
                  // "automatic"` so UIKit derives the top inset from the transparent
                  // header. A manual contentInset (which LegendList consumes into its
                  // own layout math) collapses the scroll view's adjustedContentInset
                  // top to 0, leaving the iOS 26/27 scroll-edge effect no region to
                  // render into — which is why the header blur was missing on threads.
                  scrollIndicatorInsets: { top: 0, left: 0, right: 0, bottom: 0 },
                }
              : { scrollIndicatorInsets: { top: topContentInset, bottom: 0 } })}
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            // Patched LegendList prop (patches/@legendapp__list@3.3.5.patch):
            // lets its scroll math clamp programmatic scrolls to -headerInset
            // instead of 0, so initialScrollAtEnd/maintainScrollAtEnd on short
            // content rest below the transparent header rather than at frame top.
            contentInsetStartAdjustment={usesNativeAutomaticInsets ? anchorTopInset : 0}
            contentInsetEndAdjustment={props.contentInsetEndAdjustment}
            // UIKit's automatic behavior adds the safe-area bottom on top of the
            // raw contentInset the keyboard integration writes. The detail screen
            // under-reports the composer inset by this amount (see
            // ThreadDetailScreen); this tells LegendList's scroll math about the
            // extra so programmatic end scrolls land at the true resting offset.
            contentInsetEndStaticAdjustment={usesNativeAutomaticInsets ? insets.bottom : 0}
            // Android: the composer overlay only exists as the keyboard
            // integration's animated bottom padding, which the list's scroll
            // math cannot see until the inset reports above land — and those
            // arrive via runOnJS, racing the remounted list's one-shot initial
            // scroll-at-end. Seed the estimated overlay height as a declarative
            // contentInset floor: LegendList consumes it in JS math only
            // (Android's ScrollView has no native contentInset prop) and the
            // first reported override REPLACES it instead of adding to it.
            // Not on iOS: there the prop would reach UIKit and inset natively
            // on top of the animated padding.
            {...(initialContentInset ? { contentInset: initialContentInset } : {})}
            // The keyboard integration's offset math (end pinning, max scroll)
            // must add the same UIKit-added extra, or its keyboard-open end
            // targets land one safe-area short of the true resting offset.
            adjustedInsetCompensation={usesNativeAutomaticInsets ? insets.bottom : 0}
            freeze={props.freeze}
            // Animated: on send, the optimistic message's dataChange fires
            // maintainScrollAtEnd before any render-cycle suppression could
            // engage — an instant snap there teleports the feed to the anchor
            // instead of scrolling to it. Keeping it enabled (animated) during
            // anchor scrolls also lets it correct a scroll that landed on a
            // stale end target once the anchor row finishes measuring.
            maintainScrollAtEnd={
              disclosureToggleSettling || !endFollowEnabled
                ? false
                : {
                    animated: true,
                    on: {
                      dataChange: true,
                      itemLayout: true,
                      layout: true,
                    },
                  }
            }
            maintainVisibleContentPosition={maintainVisibleContentPosition}
            data={presentedFeed}
            extraData={feedAppearanceData}
            renderItem={renderItem}
            keyExtractor={(entry) => entry.id}
            getItemType={(entry) =>
              entry.type === "message" ? `message:${entry.message.role}` : entry.type
            }
            getFixedItemSize={getFixedItemSize}
            // Measure rows well before they scroll into view so estimate→actual
            // corrections land offscreen instead of under the user's finger.
            drawDistance={500}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            keyboardLiftBehavior="whenAtEnd"
            // Seed the list's scroll math with the real viewport before its own
            // onLayout: the empty→filled remount can then tell at mount that
            // short content underflows the viewport and skip programmatic
            // positioning entirely (any offset write during screen attach races
            // UIKit's adjustedContentInset application and lands high or low).
            {...(viewportHeight > 0 && viewportWidth > 0
              ? { estimatedListSize: { height: viewportHeight, width: viewportWidth } }
              : {})}
            // RN's native scrollTo command clamps targets to a floor of
            // -contentInset.top using the RAW inset — under automatic insets the
            // header inset only exists in adjustedContentInset, so scrolls to
            // negative offsets (content top below the transparent header) get
            // clamped to 0. This prop disables that clamp; UIKit still bounces
            // user overscroll back to the adjusted rest position.
            scrollToOverflowEnabled
            estimatedItemSize={180}
            // Chat-style bottom alignment: when a thread is shorter than the
            // viewport, pad above the content so messages rest just above the
            // composer instead of under the header. No effect on threads that
            // overflow the viewport (the padding clamps to zero).
            alignItemsAtEnd
            initialScrollAtEnd
            onScroll={handleScroll}
            onContentSizeChange={handleContentSizeChange}
            onScrollBeginDrag={handleScrollBeginDrag}
            onScrollEndDrag={handleScrollEndDrag}
            onMomentumScrollBegin={handleMomentumScrollBegin}
            onMomentumScrollEnd={handleMomentumScrollEnd}
            scrollEventThrottle={16}
            // No "load earlier" header row: older pages are requested
            // automatically as the feed nears the top (see
            // threadHistoryLoadMore) and progress is shown by the absolute
            // overlay spinner below. A header row would add and remove content
            // exactly while maintainVisibleContentPosition is absorbing the
            // prepended page, which visibly jumps the feed.
            ListHeaderComponent={
              usesNativeAutomaticInsets ? null : <View style={{ height: topContentInset }} />
            }
            contentContainerStyle={{
              paddingTop: 12,
              paddingHorizontal: contentHorizontalPadding,
            }}
          />
        </View>
        {/*
          Older-page spinner. Deliberately an absolute overlay rather than a list
          header: a header would add content the moment a load starts and remove
          it the moment the page lands, and maintainVisibleContentPosition would
          have to absorb both shifts on top of the prepended page. An overlay
          contributes no layout, so the viewport stays exactly where the user
          left it.
        */}
        {historyWindow?.loadingOlderMessages === true ? (
          <View
            pointerEvents="none"
            className="absolute left-0 right-0 items-center"
            style={{ top: anchorTopInset + 8 }}
          >
            <ActivityIndicator size="small" color={iconSubtleColor} />
          </View>
        ) : null}
        {props.feed.length === 0 &&
        props.activeWorkStartedAt === null &&
        props.contentPresentation.kind === "ready" ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <ThreadFeedPlaceholder
              title="No conversation yet"
              detail="Ask the agent to inspect the repo, run a command, or continue the active thread."
              topInset={topContentInset}
              bottomInset={bottomContentInset}
              horizontalPadding={horizontalPadding}
            />
          </View>
        ) : null}
      </View>

      <ImageViewing
        images={
          expandedImage
            ? [
                {
                  uri: expandedImage.uri,
                  headers: expandedImage.headers,
                },
              ]
            : []
        }
        imageIndex={0}
        visible={expandedImage !== null}
        onRequestClose={() => setExpandedImage(null)}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </>
  );
});
