import {
  isThreadListeningLoaded,
  pauseThreadListening,
  planListeningTrackStart,
  type ListeningTrackMetadata,
  type ListeningTrackRef,
} from "@t3tools/shared/listeningPlayback";
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { useSyncExternalStore } from "react";

import {
  createPendingListeningStart,
  listeningPlayback,
  startListeningPlayback,
} from "./listeningPlayback";

/**
 * The app-scoped player behind every listening version and voice reply.
 * Living at module scope (not in a message row) lets audio keep playing
 * while the user navigates anywhere in the app; rows are views over it.
 * Kept out of listeningPlayback.ts so the coordinator wrapper stays free of
 * native expo-audio imports and runs under node tests.
 */
let sharedPlayer: AudioPlayer | null = null;
let loadedUrl: string | null = null;
let loadedTrackMetadata: ListeningTrackMetadata | null = null;
let appliedSpeed: number | null = null;
let lockScreenActive = false;

const pendingStart = createPendingListeningStart({ coordinator: listeningPlayback });

const pauseSharedPlayer = () => {
  try {
    sharedPlayer?.pause();
  } catch {
    // The native player can already be torn down during app shutdown.
  }
};

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
    // Native lock-screen play, pause, and seek actions emit this same status,
    // so every app surface stays bound to the native player's real state.
    // Position goes out before the playing flag: the at-rest state is derived
    // when the flag flips, and a finish pins the position to the end because
    // the native player's final reported position can fall short of it.
    listeningPlayback.setProgress(
      status.didJustFinish
        ? { currentTime: status.duration, duration: status.duration }
        : { currentTime: status.currentTime, duration: status.duration },
    );
    if (status.playing && listeningPlayback.getSnapshot().blocked) {
      pauseSharedPlayer();
      listeningPlayback.setTrackPlaying(false);
    } else {
      listeningPlayback.setTrackPlaying(status.playing);
    }
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
 * Loads (or resumes) a recording on the shared player and starts playback.
 * Rows always pass their freshest signed URL: a re-signed URL for the loaded
 * recording is swapped in with the position restored (or replayed from the
 * start when the old one had finished), which covers token expiry across
 * long pauses without a dedicated refresh path.
 */
export async function playListeningTrack(input: {
  readonly track: ListeningTrackRef;
  readonly metadata: ListeningTrackMetadata;
  readonly url: string;
}): Promise<void> {
  // Any direct play supersedes a still-pending play-before-URL intent.
  pendingStart.cancel();
  const player = ensureSharedPlayer();
  const plan = planListeningTrackStart({
    loadedTrack: listeningPlayback.getSnapshot().track,
    nextTrack: input.track,
    positionSeconds: player.currentTime,
    durationSeconds: player.duration,
  });
  const sameSource = plan.sameTrack && loadedUrl === input.url;

  await startListeningPlayback({
    id: input.track.speechId,
    pause: pauseSharedPlayer,
    track: input.track,
    prepareSource: sameSource
      ? undefined
      : async () => {
          appliedSpeed = null;
          player.replace(input.url);
          loadedUrl = input.url;
          loadedTrackMetadata = input.metadata;
          if (plan.resumeAt > 0) await player.seekTo(plan.resumeAt);
        },
    restartFromBeginning: sameSource && plan.finished,
    seekToBeginning: () => player.seekTo(0),
    prepareAudioMode: () =>
      setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: "doNotMix",
      }),
    applyPlaybackRate: (speed) => {
      appliedSpeed = null;
      applySharedPlaybackRate(speed);
    },
    play: () => {
      loadedTrackMetadata = input.metadata;
      activateLockScreenControls(player, input.metadata);
      try {
        player.play();
      } catch (error) {
        clearLockScreenControls(player);
        throw error;
      }
    },
  });
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
