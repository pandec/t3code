import {
  beginMessageArtifactRequest,
  getMessageArtifactSessionSnapshot,
  rememberMessageSpeech,
  subscribeMessageArtifactSession,
} from "@t3tools/client-runtime/state/messageArtifacts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type MessageId,
  type MessageSpeechSynthesisResult,
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
import { HeadphonesIcon, MinusIcon, PauseIcon, PlayIcon, PlusIcon } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useAssetUrlState, watchAssetUrl } from "../../assets/assetUrls";
import {
  listeningPlayback,
  playListeningTrack,
  seekListeningTrack,
  useListeningPlaybackProgress,
  useListeningPlaybackSnapshot,
} from "../../state/listeningPlayback";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  messageSpeechFailureDescription,
  messageSpeechFailureReasonFromError,
  messageSpeechThread,
  synthesizeMessageSpeech,
} from "../../state/voice";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface AssistantMessageSpeechState {
  readonly visible: boolean;
  readonly speech: MessageSpeechSynthesisResult | null;
  readonly expanded: boolean;
  /** This client is waiting, or the server is preparing it for any client. */
  readonly preparing: boolean;
  readonly toggle: () => void;
  /** Null when this connection cannot create recordings. */
  readonly regenerate: (() => void) | null;
}

/**
 * The listening version of a finished assistant message. Recordings and
 * pending jobs come from the thread's server-owned listening state, so every
 * connected client shows the same thing; this client's own request only adds
 * its result and failure notice.
 */
export function useAssistantMessageSpeech(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly messageId: MessageId;
  readonly text: string;
  readonly streaming: boolean;
  /** The environment can synthesize speech now. */
  readonly available: boolean;
  /** The environment streams its listening state. */
  readonly persistentJobs: boolean;
}): AssistantMessageSpeechState {
  const { environmentId, messageId, text, threadId } = input;
  const synthesize = useAtomCommand(synthesizeMessageSpeech, { reportFailure: false });
  // Creating a recording operates the environment; playing an existing one does not.
  const canCreate =
    useEnvironmentScope(environmentId, AuthOrchestrationOperateScope) && input.available;
  const threadSpeech = useEnvironmentQuery(
    input.persistentJobs && threadId !== null
      ? messageSpeechThread({ environmentId, input: { threadId } })
      : null,
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
        toastManager.add({
          type: "error",
          title: "Listening version unavailable",
          description: messageSpeechFailureDescription(reason),
        });
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
    if (!preparing && canCreate) request();
  }, [canCreate, expandedState, preparing, request, speech]);

  return {
    visible: (speech !== null || canCreate) && !input.streaming && text.trim().length > 0,
    speech,
    expanded: speech !== null && (expandedState ?? true),
    preparing,
    toggle,
    regenerate: canCreate ? request : null,
  };
}

export function AssistantMessageSpeechButton({ state }: { state: AssistantMessageSpeechState }) {
  if (!state.visible) return null;
  const noun = state.speech?.origin === "agent" ? "voice reply" : "listening version";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={state.speech === null ? "Create listening version" : `Toggle ${noun}`}
            aria-expanded={state.speech === null ? undefined : state.expanded}
            aria-busy={state.preparing}
            disabled={state.preparing && state.speech === null}
            onClick={state.toggle}
          />
        }
      >
        {state.preparing && state.speech === null ? (
          <Spinner size="sm" aria-hidden />
        ) : (
          <HeadphonesIcon className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        {state.preparing && state.speech === null
          ? "Preparing listening version"
          : state.speech === null
            ? "Listen to this response"
            : state.expanded
              ? `Hide ${noun}`
              : `Show ${noun}`}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * A view over the app-scoped player: the recording keeps playing when this
 * row unmounts or the thread changes, and remounting binds back to it.
 */
export function AssistantSpeechPlayer({
  environmentId,
  threadId,
  getThreadTitle,
  messageId,
  speech,
  messageText,
  onRetry,
}: {
  environmentId: EnvironmentId;
  /** Null when the route key failed to parse. Playback is disabled then:
      app-scoped audio without a thread identity would play with no
      indicator (and no control) anywhere in the thread lists. */
  threadId: string | null;
  getThreadTitle: () => string;
  messageId: string;
  speech: MessageSpeechSynthesisResult;
  /** The written reply; a transcript identical to it (a voice-only reply) is not repeated. */
  messageText: string;
  /** null hides the regenerate action; the agent's own recording cannot be remade. */
  onRetry: (() => void) | null;
}) {
  const { blocked, speed, track } = useListeningPlaybackSnapshot();
  const audioUrlState = useAssetUrlState(environmentId, {
    _tag: "attachment",
    attachmentId: speech.speechId,
  });
  const isActiveTrack = track !== null && track.speechId === speech.speechId;
  const isPlaying = isActiveTrack && track.playing;
  const audioUrl = audioUrlState._tag === "Success" ? audioUrlState.url : null;
  const playbackUnavailable = threadId === null;
  const isVoiceReply = speech.origin === "agent";
  const noun = isVoiceReply ? "voice reply" : "listening version";
  const showTranscript = speech.transcript.trim() !== messageText.trim();
  const trackRef = useMemo<ListeningTrackRef>(
    () => ({ environmentId, threadId: threadId ?? "", messageId, speechId: speech.speechId }),
    [environmentId, threadId, messageId, speech.speechId],
  );

  const speechId = speech.speechId;
  const handleTogglePlayback = useCallback(() => {
    if (isPlaying) {
      listeningPlayback.pauseActive();
      return;
    }
    if (audioUrl === null || playbackUnavailable) return;
    playListeningTrack({
      track: trackRef,
      metadata: { title: getThreadTitle() },
      url: audioUrl,
      // Kept by the controller so sidebar resume can re-resolve a fresh
      // signed URL long after this row unmounted.
      watchUrl: (onResolved) =>
        watchAssetUrl(environmentId, { _tag: "attachment", attachmentId: speechId }, onResolved),
    });
  }, [audioUrl, environmentId, getThreadTitle, isPlaying, playbackUnavailable, speechId, trackRef]);

  return (
    <div className="mt-2 rounded-xl border border-border/70 bg-secondary/35 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-foreground">
        <HeadphonesIcon className="size-3.5 text-muted-foreground" />
        <span>{isVoiceReply ? "Voice reply" : "Listening version"}</span>
      </div>
      {audioUrlState._tag === "Failure" ? (
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            {onRetry === null
              ? "The audio file is unavailable."
              : "The audio file is unavailable. Regenerate it to listen again."}
          </p>
          {onRetry !== null ? (
            <Button variant="outline" size="xs" onClick={onRetry}>
              Regenerate
            </Button>
          ) : null}
        </div>
      ) : audioUrlState._tag === "Loading" ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size="sm" aria-hidden />
          <span>Loading audio…</span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label={
                playbackUnavailable
                  ? "Playback unavailable"
                  : blocked
                    ? `Play ${noun} unavailable while recording`
                    : isPlaying
                      ? `Pause ${noun}`
                      : `Play ${noun}`
              }
              disabled={blocked || playbackUnavailable}
              onClick={handleTogglePlayback}
              className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground text-background outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
            >
              {isPlaying ? (
                <PauseIcon aria-hidden className="size-4 fill-current" />
              ) : (
                <PlayIcon aria-hidden className="size-4 translate-x-px fill-current" />
              )}
            </button>
            {isActiveTrack ? (
              <ListeningTransportProgress blocked={blocked} />
            ) : (
              // Same footprint as the live transport so first play causes no
              // layout shift; disabled communicates not-yet-seekable.
              <div className="min-w-0 flex-1">
                <input
                  aria-label="Playback position"
                  aria-valuetext="Not started"
                  className="settings-slider block w-full"
                  disabled
                  max={1}
                  min={0}
                  style={listeningSliderFillStyle(0)}
                  type="range"
                  value={0}
                />
                <p className="mt-0.5 text-2xs tabular-nums text-muted-foreground">
                  {formatIdleListeningClock(speech.durationMs)}
                </p>
              </div>
            )}
          </div>
          {blocked ? (
            <p className="mt-1 text-xs text-muted-foreground">Finish recording to listen.</p>
          ) : playbackUnavailable ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Playback is unavailable in this view.
            </p>
          ) : null}
          <ListeningSpeedControl speed={speed} />
        </>
      )}
      {showTranscript ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">
            {isVoiceReply ? "View transcript" : "View listening transcript"}
          </summary>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed text-foreground/85">
            {speech.transcript}
          </p>
        </details>
      ) : null}
    </div>
  );
}

/** Progress + fill offset for the settings-slider chrome, like sliderFillStyle. */
function listeningSliderFillStyle(ratio: number): CSSProperties {
  return {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
}

const LISTENING_SEEK_JUMP_S = 5;
const LISTENING_SEEK_PAGE_JUMP_S = 15;

/**
 * Live position for the loaded recording. Mounted only in the active row so
 * the throttled progress publishes never re-render inactive players or the
 * timeline.
 */
function ListeningTransportProgress({ blocked }: { blocked: boolean }) {
  const { currentTime, duration } = useListeningPlaybackProgress();
  // While dragging, the local scrub value owns the thumb: seeking commits on
  // release, so store publishes (delayed over relay/tunnel) cannot snap the
  // thumb back mid-drag. The ref mirrors the state so commit reads the
  // pending value without side effects inside a state updater.
  const [scrubTime, setScrubTimeState] = useState<number | null>(null);
  const scrubTimeRef = useRef<number | null>(null);
  const setScrubTime = useCallback((value: number | null) => {
    scrubTimeRef.current = value;
    setScrubTimeState(value);
  }, []);
  const playedTime = Math.min(currentTime, duration > 0 ? duration : currentTime);
  const shownTime = scrubTime ?? playedTime;
  const ratio = duration > 0 ? Math.min(1, shownTime / duration) : 0;

  const commitScrub = useCallback(() => {
    const pending = scrubTimeRef.current;
    setScrubTime(null);
    if (pending !== null) seekListeningTrack(pending);
  }, [setScrubTime]);
  const handleSeekKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // Native arrow steps are useless for audio: arrows jump 5s and
      // PageUp/PageDown 15s, applied immediately.
      const jump =
        event.key === "ArrowRight" || event.key === "ArrowUp"
          ? LISTENING_SEEK_JUMP_S
          : event.key === "ArrowLeft" || event.key === "ArrowDown"
            ? -LISTENING_SEEK_JUMP_S
            : event.key === "PageUp"
              ? LISTENING_SEEK_PAGE_JUMP_S
              : event.key === "PageDown"
                ? -LISTENING_SEEK_PAGE_JUMP_S
                : null;
      if (jump !== null) {
        event.preventDefault();
        const upperBound = duration > 0 ? duration : playedTime;
        seekListeningTrack(Math.min(Math.max(0, playedTime + jump), upperBound));
        setScrubTime(null);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        seekListeningTrack(0);
        setScrubTime(null);
        return;
      }
      if (event.key === "End" && duration > 0) {
        event.preventDefault();
        seekListeningTrack(duration);
        setScrubTime(null);
      }
    },
    [duration, playedTime, setScrubTime],
  );

  return (
    <div className="min-w-0 flex-1">
      <input
        aria-label="Playback position"
        aria-valuetext={`${formatListeningClock(shownTime)} of ${formatListeningClock(duration)}`}
        className="settings-slider block w-full"
        disabled={blocked}
        max={duration > 0 ? duration : 0}
        min={0}
        onBlur={commitScrub}
        onChange={(event) => setScrubTime(event.currentTarget.valueAsNumber)}
        onKeyDown={handleSeekKeyDown}
        onPointerCancel={() => setScrubTime(null)}
        onPointerUp={commitScrub}
        // Continuous, so the thumb sits on the exact position.
        step="any"
        style={listeningSliderFillStyle(ratio)}
        type="range"
        value={shownTime}
      />
      <p className="mt-0.5 text-2xs tabular-nums text-muted-foreground">
        {formatListeningClock(shownTime)} / {formatListeningClock(duration)}
      </p>
    </div>
  );
}

function ListeningSpeedControl({ speed }: { speed: number }) {
  const speedLabel = listeningSpeedSpokenLabel(speed);

  return (
    <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>Playback speed</span>
      <div aria-label="Playback speed" className="flex items-center gap-1" role="group">
        <Button
          aria-label="Decrease playback speed"
          disabled={speed <= LISTENING_SPEED_MIN}
          onClick={() => listeningPlayback.nudgeSpeed(-1)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <MinusIcon className="size-3.5" />
        </Button>
        <Menu>
          <MenuTrigger
            aria-label={`Playback speed, ${speedLabel}`}
            render={<Button size="xs" variant="outline" />}
          >
            <span aria-live="polite" className="min-w-12 tabular-nums">
              {formatListeningSpeed(speed)}
            </span>
          </MenuTrigger>
          <MenuPopup align="center" side="top" className="min-w-32">
            <MenuRadioGroup
              value={String(speed)}
              onValueChange={(value) => listeningPlayback.setSpeed(Number(value))}
            >
              {LISTENING_SPEED_PRESETS.map((preset) => (
                <MenuRadioItem key={preset} value={String(preset)}>
                  {formatListeningSpeed(preset)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
        <Button
          aria-label="Increase playback speed"
          disabled={speed >= LISTENING_SPEED_MAX}
          onClick={() => listeningPlayback.nudgeSpeed(1)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
