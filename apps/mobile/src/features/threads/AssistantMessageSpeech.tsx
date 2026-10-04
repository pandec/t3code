import {
  beginMessageArtifactRequest,
  getMessageArtifactSessionSnapshot,
  rememberMessageSpeech,
  subscribeMessageArtifactSession,
} from "@t3tools/client-runtime/state/messageArtifacts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type MessageId,
  type MessageSpeechSynthesisResult,
  speechAudioFileExtension,
  type ThreadId,
} from "@t3tools/contracts";
import {
  formatIdleListeningClock,
  formatListeningClock,
  formatListeningSpeed,
  LISTENING_SPEED_MAX,
  LISTENING_SPEED_MIN,
  LISTENING_SPEED_PRESETS,
  listeningSpeedSpokenLabel,
  type ListeningTrackRef,
} from "@t3tools/shared/listeningPlayback";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, type ColorValue, Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { useAssetUrlState, watchAssetUrl } from "../../state/assets";
import {
  listeningPlayback,
  useListeningPlaybackProgress,
  useListeningPlaybackSnapshot,
} from "../../state/listeningPlayback";
import { requestListeningTrack, usePendingListeningSpeechId } from "../../state/listeningPlayer";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  messageSpeechFailureDescription,
  messageSpeechFailureReasonFromError,
  messageSpeechThread,
  synthesizeMessageSpeech,
} from "../../state/voice";
import { listeningPlayerChrome } from "./listeningPlayerChrome";

export interface AssistantMessageSpeechState {
  readonly visible: boolean;
  readonly speech: MessageSpeechSynthesisResult | null;
  readonly expanded: boolean;
  /** This client is waiting, or the server is preparing it for any client. */
  readonly preparing: boolean;
  readonly toggle: () => void;
  readonly regenerate: () => void;
}

/**
 * The listening version of a finished assistant message. Recordings and
 * pending jobs come from the thread's server-owned listening state, so every
 * connected client shows the same thing; this client's own request only adds
 * its result and failure notice.
 */
export function useAssistantMessageSpeech(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  /** The environment can synthesize speech now. */
  readonly available: boolean;
  /** The environment streams its listening state. */
  readonly persistentJobs: boolean;
}): AssistantMessageSpeechState {
  const { environmentId, messageId, text, threadId } = input;
  const synthesize = useAtomCommand(synthesizeMessageSpeech, { reportFailure: false });
  const threadSpeech = useEnvironmentQuery(
    input.persistentJobs ? messageSpeechThread({ environmentId, input: { threadId } }) : null,
  ).data;
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
  const speech = threadSpeech?.recordings.get(messageId) ?? session.speech;
  const serverPending = threadSpeech?.pending.has(messageId) ?? false;
  const serverPendingRef = useRef(serverPending);
  useEffect(() => {
    serverPendingRef.current = serverPending;
  }, [serverPending]);
  const [requesting, setRequesting] = useState(false);
  // null = untouched: a message that already has a recording shows its
  // player, so reopening a thread shows which messages have one.
  const [expandedState, setExpandedState] = useState<boolean | null>(null);
  const preparing = requesting || serverPending;

  const request = useCallback(() => {
    if (requesting) return;
    setRequesting(true);
    const endRequest = beginMessageArtifactRequest(environmentId, messageId);
    void synthesize({ environmentId, input: { messageId } })
      .then((result) => {
        if (result._tag === "Success") {
          rememberMessageSpeech(environmentId, text, result.value);
          setExpandedState(true);
          return;
        }
        const reason = messageSpeechFailureReasonFromError(squashAtomCommandFailure(result));
        // A dropped connection says nothing about the server's job, which the
        // thread's listening state still shows.
        if (reason === undefined && serverPendingRef.current) return;
        Alert.alert("Listening version unavailable", messageSpeechFailureDescription(reason));
      })
      .finally(() => {
        setRequesting(false);
        endRequest();
      });
  }, [environmentId, messageId, requesting, synthesize, text]);

  const toggle = useCallback(() => {
    if (speech !== null) {
      setExpandedState(!(expandedState ?? true));
      return;
    }
    if (!preparing) request();
  }, [expandedState, preparing, request, speech]);

  return {
    visible: (speech !== null || input.available) && text.trim().length > 0,
    speech,
    expanded: speech !== null && (expandedState ?? true),
    preparing,
    toggle,
    regenerate: request,
  };
}

export function AssistantMessageSpeechButton(props: {
  readonly state: AssistantMessageSpeechState;
  readonly iconSubtleColor: ColorValue;
}) {
  const { state } = props;
  if (!state.visible) return null;
  const busy = state.preparing && state.speech === null;
  const noun = state.speech?.origin === "agent" ? "voice reply" : "listening version";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={state.speech === null ? "Create listening version" : `Toggle ${noun}`}
      accessibilityState={{
        expanded: state.speech === null ? undefined : state.expanded,
        busy,
      }}
      className="size-7 items-center justify-center rounded-lg active:bg-subtle-strong"
      disabled={busy}
      hitSlop={8}
      onPress={state.toggle}
    >
      {busy ? (
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
  );
}

/**
 * A view over the app-scoped player: the recording keeps playing when this
 * row unmounts (thread switches, virtualization), and remounting binds back
 * to it. The audio is fetched only when play is pressed, since a thread can
 * hold many recordings and the app may be on a remote or cellular link.
 */
export function AssistantSpeechPlayer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly messageId: MessageId;
  readonly speech: MessageSpeechSynthesisResult;
  /** The written reply; a transcript identical to it (a voice-only reply) is not repeated. */
  readonly messageText: string;
  readonly iconSubtleColor: ColorValue;
  /** The theme's `--color-foreground`, which the scrubber and speed pill derive from. */
  readonly foregroundColor: string;
  /** Glyph color on the `bg-foreground` play button; from the background family
      so it stays legible on every theme. */
  readonly onForegroundColor: ColorValue;
  /** null hides the regenerate action; the agent's own recording cannot be remade. */
  readonly onRetry: (() => void) | null;
}) {
  const { blocked, speed, track } = useListeningPlaybackSnapshot();
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const { trackColor, outlineColor } = listeningPlayerChrome(props.foregroundColor);
  const isVoiceReply = props.speech.origin === "agent";
  const noun = isVoiceReply ? "voice reply" : "listening version";
  const showTranscript = props.speech.transcript.trim() !== props.messageText.trim();
  const speechId = props.speech.speechId;
  const speechMimeType = props.speech.mimeType;
  const environmentId = props.environmentId;
  const audioUrlState = useAssetUrlState(environmentId, {
    _tag: "attachment",
    attachmentId: speechId,
    fileName: `${speechId}${speechAudioFileExtension(speechMimeType)}`,
    mimeType: speechMimeType,
  });
  const audioUrl = audioUrlState._tag === "Success" ? audioUrlState.url : null;
  const isActiveTrack = track !== null && track.speechId === speechId;
  const isPlaying = isActiveTrack && track.playing;
  // The play-before-URL intent lives in the controller, not this row; the
  // row only mirrors it for the loading spinner.
  const pendingSpeechId = usePendingListeningSpeechId();

  const trackRef = useMemo<ListeningTrackRef>(
    () => ({
      environmentId,
      threadId: props.threadId,
      messageId: props.messageId,
      speechId,
    }),
    [environmentId, props.threadId, props.messageId, speechId],
  );
  const threadTitle = props.threadTitle;
  const onTogglePlayback = useCallback(() => {
    if (isPlaying) {
      listeningPlayback.pauseActive();
      return;
    }
    if (blocked) return;
    requestListeningTrack({
      track: trackRef,
      metadata: { title: threadTitle },
      url: audioUrl,
      watchUrl: (onResolved) =>
        watchAssetUrl(
          environmentId,
          {
            _tag: "attachment",
            attachmentId: speechId,
            fileName: `${speechId}${speechAudioFileExtension(speechMimeType)}`,
            mimeType: speechMimeType,
          },
          onResolved,
        ),
    });
  }, [
    audioUrl,
    blocked,
    environmentId,
    isPlaying,
    speechId,
    speechMimeType,
    threadTitle,
    trackRef,
  ]);

  return (
    <View className="mt-2 gap-2 rounded-2xl border border-border bg-subtle p-3">
      <View className="flex-row items-center gap-2">
        <SymbolView
          name="headphones"
          size={14}
          tintColor={props.iconSubtleColor}
          type="monochrome"
        />
        <Text className="font-t3-bold text-xs text-foreground">
          {isVoiceReply ? "Voice reply" : "Listening version"}
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
      ) : audioUrl === null && pendingSpeechId === speechId ? (
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
                  ? `Play ${noun} unavailable while recording`
                  : isPlaying
                    ? `Pause ${noun}`
                    : `Play ${noun}`
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
                tintColor={props.onForegroundColor}
                type="monochrome"
              />
            </Pressable>
            {isActiveTrack ? (
              <ListeningTransportProgress trackColor={trackColor} />
            ) : (
              // Same footprint as the live transport so first play causes no
              // layout shift.
              <View className="flex-1 gap-1.5">
                <View
                  className="h-1.5 overflow-hidden rounded-full"
                  style={{ backgroundColor: trackColor }}
                />
                <Text className="font-t3-medium text-[11px] tabular-nums text-foreground-muted">
                  {formatIdleListeningClock(props.speech.durationMs)}
                </Text>
              </View>
            )}
          </View>
          {blocked ? (
            <Text className="text-xs text-foreground-muted">Finish recording to listen.</Text>
          ) : null}
          <ListeningSpeedControl outlineColor={outlineColor} speed={speed} />
        </View>
      )}
      {showTranscript ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: transcriptExpanded }}
          className="min-h-8 flex-row items-center gap-1"
          onPress={() => setTranscriptExpanded((current) => !current)}
        >
          <Text className="font-t3-medium text-xs text-foreground-muted">
            {isVoiceReply ? "View transcript" : "View listening transcript"}
          </Text>
          <SymbolView
            name={transcriptExpanded ? "chevron.up" : "chevron.down"}
            size={13}
            tintColor={props.iconSubtleColor}
            type="monochrome"
          />
        </Pressable>
      ) : null}
      {showTranscript && transcriptExpanded ? (
        <Text className="text-sm leading-5 text-foreground-muted">{props.speech.transcript}</Text>
      ) : null}
    </View>
  );
}

/**
 * Live position for the loaded recording. Mounted only in the active row so
 * the player's progress tick never re-renders inactive players or the feed.
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
