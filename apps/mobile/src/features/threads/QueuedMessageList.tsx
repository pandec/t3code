import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  queuedThreadMessageIntent,
  queuedThreadMessagePreview,
  type QueuedThreadMessage,
} from "../../state/thread-outbox-model";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import {
  deleteQueuedMessage,
  editQueuedMessage,
  steerQueuedMessageNow,
} from "../../state/use-thread-outbox-actions";
import { dispatchingQueuedMessageIdAtom } from "../../state/use-thread-outbox-drain";

function confirmDeleteQueuedMessage(message: QueuedThreadMessage): void {
  Alert.alert(
    "Delete queued message?",
    "It has not been sent yet and will be removed from the queue.",
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => void deleteQueuedMessage(message),
      },
    ],
  );
}

const QueuedMessageRow = memo(function QueuedMessageRow(props: {
  readonly message: QueuedThreadMessage;
  readonly isDispatching: boolean;
  readonly isFirst: boolean;
}) {
  const iconColor = useThemeColor("--color-icon");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const dangerFg = useThemeColor("--color-danger-foreground");
  const message = props.message;
  // The steer slot stays in the row once the intent is "steer" (just waiting
  // to dispatch) so the three action columns never shift; it only disables.
  const canSteer = queuedThreadMessageIntent(message) === "queue" && !props.isDispatching;

  return (
    <View
      className={cn(
        "flex-row items-center gap-1 py-1 pl-4 pr-2",
        !props.isFirst && "border-t border-neutral-200 dark:border-white/6",
      )}
    >
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {queuedThreadMessagePreview(message)}
      </Text>
      <Pressable
        accessibilityLabel="Send now"
        accessibilityRole="button"
        className="size-9 items-center justify-center rounded-full active:opacity-70"
        disabled={!canSteer}
        onPress={() => void steerQueuedMessageNow(message)}
      >
        {props.isDispatching ? (
          <ActivityIndicator size="small" color={iconSubtle} />
        ) : (
          <SymbolView
            name="arrow.up"
            size={15}
            tintColor={canSteer ? iconColor : iconSubtle}
            type="monochrome"
          />
        )}
      </Pressable>
      <Pressable
        accessibilityLabel="Edit queued message"
        accessibilityRole="button"
        className="size-9 items-center justify-center rounded-full active:opacity-70"
        disabled={props.isDispatching}
        onPress={() => void editQueuedMessage(message)}
      >
        <SymbolView
          name="pencil"
          size={15}
          tintColor={props.isDispatching ? iconSubtle : iconColor}
          type="monochrome"
        />
      </Pressable>
      <Pressable
        accessibilityLabel="Delete queued message"
        accessibilityRole="button"
        className="size-9 items-center justify-center rounded-full active:opacity-70"
        disabled={props.isDispatching}
        onPress={() => confirmDeleteQueuedMessage(message)}
      >
        <SymbolView
          name="trash"
          size={15}
          tintColor={props.isDispatching ? iconSubtle : dangerFg}
          type="monochrome"
        />
      </Pressable>
    </View>
  );
});

/**
 * Queued messages waiting in the outbox for the selected thread, FIFO, shown
 * above the composer. Pending-task creations are excluded — they keep their
 * NewTaskDraftScreen flow and appear in the thread list instead.
 */
export const QueuedMessageList = memo(function QueuedMessageList(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const threadKey = scopedThreadKey(props.environmentId, props.threadId);
  const messages = useMemo(
    () =>
      (queuedMessagesByThreadKey[threadKey] ?? []).filter(
        (message) => message.creation === undefined,
      ),
    [queuedMessagesByThreadKey, threadKey],
  );

  if (messages.length === 0) {
    return null;
  }

  return (
    <Animated.View
      className="shrink-0 px-4 pb-3"
      entering={FadeInDown.duration(220)}
      exiting={FadeOut.duration(140)}
    >
      <View className="overflow-hidden rounded-[20px] border border-neutral-200 bg-neutral-100/80 py-1 dark:border-white/6 dark:bg-neutral-900/80">
        <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
          {messages.map((message, index) => (
            <QueuedMessageRow
              key={message.messageId}
              message={message}
              isDispatching={dispatchingQueuedMessageId === message.messageId}
              isFirst={index === 0}
            />
          ))}
        </ScrollView>
      </View>
    </Animated.View>
  );
});
