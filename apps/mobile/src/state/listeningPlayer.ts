import {
  isThreadListeningLoaded,
  pauseThreadListening,
  planListeningTrackStart,
  type ListeningTrackMetadata,
  type ListeningTrackRef,
} from "@t3tools/shared/listeningPlayback";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { useSyncExternalStore } from "react";

import {
  acquireAudioSession,
  activateAudioSession,
  isAudioSessionOwner,
  pauseAudioPlayer,
  releaseAudioSession,
} from "../lib/audioSession";

import {
  createPendingListeningStart,
  listeningPlayback,
  startListeningPlayback,
} from "./listeningPlayback";

/**
 * Module scope (not a message row) keeps audio playing while the user navigates; rows are views
 * over it. Kept out of listeningPlayback.ts so that wrapper stays free of native expo-audio
 * imports and runs under node tests.
 */
let sharedPlayer: AudioPlayer | null = null;
let loadedUrl: string | null = null;
let loadedTrackMetadata: ListeningTrackMetadata | null = null;
let appliedSpeed: number | null = null;
let lockScreenActive = false;
type AudioSessionToken = ReturnType<typeof acquireAudioSession>;
let sessionToken: AudioSessionToken | null = null;
// Statuses from before a start (the paused player, a stale error) must not release its session.
// The latest start holds this until it gives up, or after play() until a status that is not the
// stale pre-play pause: a terminal one, or buffering or playing.
let startingAttempt: { played: boolean } | null = null;
// Expo reports a source failure once, so a retry must load the source again. Statuses carry no
// source identity and arrive late, so a failure from a replaced source sets this too.
let loadedSourceFailed = false;

const pendingStart = createPendingListeningStart({ coordinator: listeningPlayback });

function releaseListeningSession(token = sessionToken): void {
  if (token === null) return;
  if (sessionToken === token) sessionToken = null;
  void releaseAudioSession(token).catch(() => {});
}

const pauseSharedPlayer = () => {
  try {
    if (sharedPlayer !== null) pauseAudioPlayer(sharedPlayer);
  } catch {
    // The native player can already be torn down during app shutdown.
  }
  releaseListeningSession();
};

/** Takes the app-wide audio session from inline media; null while a recording holds it. */
function acquireListeningSession(player: AudioPlayer): AudioSessionToken | null {
  if (sessionToken !== null && isAudioSessionOwner(sessionToken)) return sessionToken;
  const token = acquireAudioSession(
    "playback",
    () => {
      // Lock-screen controls would otherwise resume over the new owner.
      deactivateLockScreenControls(player);
      pauseSharedPlayer();
    },
    () => {
      try {
        pauseAudioPlayer(player);
      } catch {}
    },
  );
  if (!isAudioSessionOwner(token)) return null;
  sessionToken = token;
  return token;
}

function activateListeningSession(token: AudioSessionToken) {
  return activateAudioSession(token, false, { background: true });
}

function applySharedPlaybackRate(speed: number): void {
  const player = sharedPlayer;
  if (player === null || appliedSpeed === speed) return;
  try {
    player.shouldCorrectPitch = true;
    player.setPlaybackRate(speed, "high");
    appliedSpeed = speed;
  } catch {
    // The native player may not be loaded yet; the play path applies it again.
  }
}

function activateLockScreenControls(player: AudioPlayer, metadata: ListeningTrackMetadata): void {
  try {
    player.setActiveForLockScreen(
      true,
      { title: metadata.title, artist: "T3 Code" },
      { showSeekForward: true, showSeekBackward: true },
    );
    lockScreenActive = true;
  } catch {
    // Lock-screen binding is decoration; playback must not depend on it.
  }
}

function deactivateLockScreenControls(player: AudioPlayer): void {
  if (!lockScreenActive) return;
  try {
    player.setActiveForLockScreen(false);
  } catch {
    // The native player can already be torn down during app shutdown.
  }
  lockScreenActive = false;
}

function clearLockScreenControls(player: AudioPlayer): void {
  try {
    player.clearLockScreenControls();
  } catch {
    // The native player can already be torn down during app shutdown.
  }
  lockScreenActive = false;
}

function ensureSharedPlayer(): AudioPlayer {
  if (sharedPlayer !== null) return sharedPlayer;
  const player = createAudioPlayer(null, { updateInterval: 250 });
  player.addListener("playbackStatusUpdate", (status) => {
    // Lock-screen actions emit this same status, so surfaces stay bound to the native state.
    // Position goes out before the playing flag, which derives the at-rest state; a finish pins
    // the position to the end because the native final position can fall short of it.
    const duration = Number.isFinite(status.duration) ? status.duration : 0;
    listeningPlayback.setProgress(
      status.didJustFinish
        ? { currentTime: duration, duration }
        : { currentTime: status.currentTime, duration },
    );
    const snapshot = listeningPlayback.getSnapshot();
    // A stopped clock also reports buffering and seeks; a lock-screen pause reports a paused one.
    const nativePause =
      !status.playing && !status.isBuffering && status.timeControlStatus === "paused";
    const terminal = status.didJustFinish || status.error !== null;
    if (status.error !== null) loadedSourceFailed = true;
    if (startingAttempt?.played === true && (terminal || !nativePause)) startingAttempt = null;
    if (sessionToken !== null && startingAttempt === null && (terminal || nativePause)) {
      releaseListeningSession();
    }
    if (status.playing && snapshot.blocked) {
      pauseSharedPlayer();
      listeningPlayback.setTrackPlaying(false);
      return;
    }
    // A lock-screen resume bypasses playListeningTrack. Only a paused-to-playing edge
    // counts, so a status queued before a pause cannot take the session back.
    if (
      status.playing &&
      snapshot.track?.playing === false &&
      lockScreenActive &&
      sessionToken === null
    ) {
      const token = acquireListeningSession(player);
      if (token !== null) {
        void activateListeningSession(token).catch(() => {
          if (sessionToken === token) pauseSharedPlayer();
        });
      }
    }
    listeningPlayback.setTrackPlaying(status.playing);
  });
  sharedPlayer = player;
  // Speed changes mid-playback land on the native player immediately.
  listeningPlayback.subscribe(() => {
    const snapshot = listeningPlayback.getSnapshot();
    if (loadedUrl !== null) applySharedPlaybackRate(snapshot.speed);
    // Recording pauses playback without auto-resume. Removing the native
    // controls closes the one path that could otherwise bypass that block.
    if (snapshot.blocked) deactivateLockScreenControls(player);
  });
  return player;
}

/**
 * Rows always pass their freshest signed URL: a re-signed URL for the loaded recording is swapped
 * in with the position restored (or replayed when finished), which covers token expiry across
 * long pauses without a dedicated refresh path.
 */
export async function playListeningTrack(input: {
  readonly track: ListeningTrackRef;
  readonly metadata: ListeningTrackMetadata;
  readonly url: string;
}): Promise<void> {
  // Any direct play supersedes a still-pending play-before-URL intent.
  pendingStart.cancel();
  if (listeningPlayback.getSnapshot().blocked) return;
  const player = ensureSharedPlayer();
  // Startup would pause the other recording, releasing the session taken below; pause it first.
  const loaded = listeningPlayback.getSnapshot().track;
  if (
    loaded !== null &&
    loaded.speechId !== input.track.speechId &&
    listeningPlayback.isActive(loaded.speechId, pauseSharedPlayer)
  ) {
    listeningPlayback.pauseActive();
    listeningPlayback.release(loaded.speechId, pauseSharedPlayer);
  }
  // Taken before preparing the source, so media started meanwhile cancels this attempt.
  const token = acquireListeningSession(player);
  if (token === null) return;
  const plan = planListeningTrackStart({
    loadedTrack: listeningPlayback.getSnapshot().track,
    nextTrack: input.track,
    positionSeconds: player.currentTime,
    durationSeconds: player.duration,
  });
  const sameSource = plan.sameTrack && loadedUrl === input.url && !loadedSourceFailed;

  const attempt = { played: false };
  startingAttempt = attempt;
  await startListeningPlayback({
    id: input.track.speechId,
    pause: pauseSharedPlayer,
    track: input.track,
    prepareSource: sameSource
      ? undefined
      : async () => {
          appliedSpeed = null;
          player.replace(input.url);
          loadedSourceFailed = false;
          loadedUrl = input.url;
          loadedTrackMetadata = input.metadata;
          if (plan.resumeAt > 0) await player.seekTo(plan.resumeAt);
        },
    restartFromBeginning: sameSource && plan.finished,
    seekToBeginning: () => player.seekTo(0),
    prepareAudioMode: async () => {
      await activateListeningSession(token);
    },
    applyPlaybackRate: (speed) => {
      appliedSpeed = null;
      applySharedPlaybackRate(speed);
    },
    play: () => {
      loadedTrackMetadata = input.metadata;
      // Another owner (or a recording) took the session during startup; stay loaded and paused.
      if (!isAudioSessionOwner(token)) return;
      activateLockScreenControls(player, input.metadata);
      try {
        player.play();
        attempt.played = true;
      } catch (error) {
        clearLockScreenControls(player);
        throw error;
      }
    },
  });
  if (startingAttempt === attempt && !attempt.played) startingAttempt = null;
  // A failed or superseded start leaves this recording inactive, and its session goes with it.
  if (!listeningPlayback.isActive(input.track.speechId, pauseSharedPlayer)) {
    releaseListeningSession(token);
  }
}

/**
 * Row entry point. With a resolved URL it plays immediately; without one it
 * arms the controller-owned pending start, which survives the row unmounting
 * and plays once the watch resolves the URL.
 */
export function requestListeningTrack(input: {
  readonly track: ListeningTrackRef;
  readonly metadata: ListeningTrackMetadata;
  readonly url: string | null;
  readonly watchUrl: (onResolved: (url: string | null) => void) => () => void;
}): void {
  if (input.url !== null) {
    void playListeningTrack({ track: input.track, metadata: input.metadata, url: input.url });
    return;
  }
  pendingStart.begin({
    track: input.track,
    watch: input.watchUrl,
    play: (url) => void playListeningTrack({ track: input.track, metadata: input.metadata, url }),
  });
}

/** Play/pause toggle for the loaded track, usable from any thread-list row. */
export function toggleLoadedListeningTrack(): void {
  const track = listeningPlayback.getSnapshot().track;
  if (track === null) return;
  if (track.playing) {
    listeningPlayback.pauseActive();
    return;
  }
  if (loadedUrl === null || loadedTrackMetadata === null) return;
  void playListeningTrack({ track, metadata: loadedTrackMetadata, url: loadedUrl });
}

/**
 * Pauses playback owned by the thread without clearing it (used when it is
 * archived): archived rows leave every list surface that carries the pause
 * control, so the audio must not keep playing — but the recording stays
 * loaded and resumable. A pending start for the thread is dropped too.
 */
export function pauseListeningForThread(environmentId: string, threadId: string): void {
  pendingStart.cancelForThread(environmentId, threadId);
  if (isThreadListeningLoaded(listeningPlayback.getSnapshot(), environmentId, threadId)) {
    if (sharedPlayer !== null) deactivateLockScreenControls(sharedPlayer);
  }
  pauseThreadListening(listeningPlayback, environmentId, threadId);
}

/**
 * Stops and clears playback owned by the thread (used when it is deleted):
 * the loaded track, and any pending play-before-URL intent, must not outlive
 * the thread that owns them.
 */
export function stopListeningForThread(environmentId: string, threadId: string): void {
  pendingStart.cancelForThread(environmentId, threadId);
  const snapshot = listeningPlayback.getSnapshot();
  if (!isThreadListeningLoaded(snapshot, environmentId, threadId)) return;
  const track = snapshot.track;
  if (track === null) return;
  pauseSharedPlayer();
  if (sharedPlayer !== null) clearLockScreenControls(sharedPlayer);
  loadedUrl = null;
  loadedTrackMetadata = null;
  listeningPlayback.release(track.speechId, pauseSharedPlayer);
  listeningPlayback.setTrack(null);
}

/** Speech id of the armed play-before-URL intent; drives the row spinner. */
export function usePendingListeningSpeechId(): string | null {
  return useSyncExternalStore(
    pendingStart.subscribe,
    pendingStart.getPendingSpeechId,
    pendingStart.getPendingSpeechId,
  );
}
