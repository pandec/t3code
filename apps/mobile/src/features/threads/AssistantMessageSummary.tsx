import {
  beginMessageArtifactRequest,
  getMessageArtifactSessionSnapshot,
  rememberMessageSummary,
  subscribeMessageArtifactSession,
} from "@t3tools/client-runtime/state/messageArtifacts";
import { currentThreadMessageSummary } from "@t3tools/client-runtime/state/voice";
import type { EnvironmentId, MessageId, MessageSummaryResult, ThreadId } from "@t3tools/contracts";
import { type ReactNode, useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, type ColorValue, Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { summarizeMessage } from "../../state/messageArtifacts";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { messageSpeechThread } from "../../state/voice";
import {
  AssistantMessageSpeechButton,
  AssistantSpeechPlayer,
  useAssistantMessageSpeech,
} from "./AssistantMessageSpeech";

export interface AssistantMessageSummaryState {
  readonly visible: boolean;
  readonly summary: MessageSummaryResult | null;
  readonly expanded: boolean;
  readonly preparing: boolean;
  readonly toggle: () => void;
}

/**
 * On-demand summary of a finished assistant message. Stored summaries come
 * with the thread's listening state, so they show after a reload without
 * asking again (and to read-only clients); this client's own request only
 * adds its result.
 */
export function useAssistantMessageSummary(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly available: boolean;
  /** The environment streams its listening state, stored summaries included. */
  readonly persistentJobs: boolean;
}): AssistantMessageSummaryState {
  const { environmentId, messageId, text, threadId } = input;
  const summarize = useAtomCommand(summarizeMessage, { reportFailure: false });
  const threadState = useEnvironmentQuery(
    input.persistentJobs ? messageSpeechThread({ environmentId, input: { threadId } }) : null,
  ).data;
  const [preparing, setPreparing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const readSession = useCallback(
    () => getMessageArtifactSessionSnapshot(environmentId, messageId, text),
    [environmentId, messageId, text],
  );
  const session = useSyncExternalStore(
    useCallback(
      (listener) => subscribeMessageArtifactSession(environmentId, messageId, listener),
      [environmentId, messageId],
    ),
    readSession,
    readSession,
  );
  const storedSummary = useMemo(
    () => currentThreadMessageSummary(threadState, messageId, text),
    [threadState, messageId, text],
  );
  const summary = session.summary ?? storedSummary;

  const toggle = useCallback(() => {
    if (summary !== null) {
      setExpanded((current) => !current);
      return;
    }
    if (preparing) return;
    setPreparing(true);
    const endRequest = beginMessageArtifactRequest(environmentId, messageId);
    void summarize({ environmentId, input: { messageId } })
      .then((result) => {
        if (result._tag === "Success") {
          rememberMessageSummary(environmentId, text, result.value);
          setExpanded(true);
          return;
        }
        Alert.alert(
          "Summary unavailable",
          "T3 Code could not summarize this message. Try again in a moment.",
        );
      })
      .finally(() => {
        setPreparing(false);
        endRequest();
      });
  }, [environmentId, messageId, preparing, summarize, summary, text]);

  return {
    visible: (summary !== null || input.available) && text.trim().length > 0,
    summary,
    expanded: summary !== null && expanded,
    preparing,
    toggle,
  };
}

/** Meta row under a finished assistant message, with its summary and listening controls. */
export function AssistantMessageMeta(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly messageId: MessageId;
  readonly messageText: string;
  readonly summariesAvailable: boolean;
  readonly textToSpeechAvailable: boolean;
  readonly textToSpeechPersistentJobs: boolean;
  readonly timestampLabel: string;
  readonly iconSubtleColor: ColorValue;
  /** The theme's `--color-foreground`, for the listening player. */
  readonly foregroundColor: string;
  /** Glyph color on the player's `bg-foreground` play button. */
  readonly onForegroundColor: ColorValue;
  /** Renders the summary's markdown the way the feed renders assistant text. */
  readonly renderSummary: (markdown: string) => ReactNode;
  readonly children: ReactNode;
}) {
  const { environmentId, messageId, messageText } = props;
  const summary = useAssistantMessageSummary({
    environmentId,
    threadId: props.threadId,
    messageId,
    text: messageText,
    available: props.summariesAvailable,
    persistentJobs: props.textToSpeechPersistentJobs,
  });
  const speech = useAssistantMessageSpeech({
    environmentId,
    threadId: props.threadId,
    messageId,
    text: messageText,
    available: props.textToSpeechAvailable,
    persistentJobs: props.textToSpeechPersistentJobs,
  });

  return (
    <View>
      <View className="mt-1 flex-row items-center gap-1">
        {props.children}
        {summary.visible ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={summary.summary === null ? "Create summary" : "Toggle summary"}
            accessibilityState={{
              expanded: summary.summary === null ? undefined : summary.expanded,
              busy: summary.preparing,
            }}
            className="size-7 items-center justify-center rounded-lg active:bg-subtle-strong"
            disabled={summary.preparing}
            hitSlop={8}
            onPress={summary.toggle}
          >
            {summary.preparing ? (
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
        <AssistantMessageSpeechButton state={speech} iconSubtleColor={props.iconSubtleColor} />
        <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
          {props.timestampLabel}
        </Text>
      </View>
      {summary.expanded && summary.summary !== null ? (
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
          {props.renderSummary(summary.summary.summary)}
        </View>
      ) : null}
      {speech.expanded && speech.speech !== null ? (
        <AssistantSpeechPlayer
          environmentId={environmentId}
          threadId={props.threadId}
          threadTitle={props.threadTitle}
          messageId={messageId}
          speech={speech.speech}
          messageText={messageText}
          iconSubtleColor={props.iconSubtleColor}
          foregroundColor={props.foregroundColor}
          onForegroundColor={props.onForegroundColor}
          onRetry={speech.speech.origin === "agent" ? null : speech.regenerate}
        />
      ) : null}
    </View>
  );
}
