import {
  isThreadListeningLoaded,
  pauseThreadListening,
  planListeningTrackStart,
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
let appliedSpeed: number | null = null;

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

function ensureSharedPlayer(): AudioPlayer {
  if (sharedPlayer !== null) return sharedPlayer;
  const player = createAudioPlayer(null, { updateInterval: 250 });
  player.addListener("playbackStatusUpdate", (status) => {
    listeningPlayback.setTrackPlaying(status.playing);
    listeningPlayback.setProgress({
      currentTime: status.currentTime,
      duration: status.duration,
    });
  });
  sharedPlayer = player;
  // Speed changes mid-playback land on the native player immediately.
  listeningPlayback.subscribe(() => {
    if (loadedUrl !== null) applySharedPlaybackRate(listeningPlayback.getSnapshot().speed);
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
          if (plan.resumeAt > 0) await player.seekTo(plan.resumeAt);
        },
    restartFromBeginning: sameSource && plan.finished,
    seekToBeginning: () => player.seekTo(0),
    prepareAudioMode: () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }),
    applyPlaybackRate: (speed) => {
      appliedSpeed = null;
      applySharedPlaybackRate(speed);
    },
    play: () => player.play(),
  });
}

/**
 * Row entry point. With a resolved URL it plays immediately; without one it
 * arms the controller-owned pending start, which survives the row unmounting
 * and plays once the watch resolves the URL.
 */
export function requestListeningTrack(input: {
  readonly track: ListeningTrackRef;
  readonly url: string | null;
  readonly watchUrl: (onResolved: (url: string | null) => void) => () => void;
}): void {
  if (input.url !== null) {
    void playListeningTrack({ track: input.track, url: input.url });
    return;
  }
  pendingStart.begin({
    track: input.track,
    watch: input.watchUrl,
    play: (url) => void playListeningTrack({ track: input.track, url }),
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
  if (loadedUrl === null) return;
  void playListeningTrack({ track, url: loadedUrl });
}

/**
 * Pauses playback owned by the thread without clearing it (used when it is
 * archived): archived rows leave every list surface that carries the pause
 * control, so the audio must not keep playing — but the recording stays
 * loaded and resumable. A pending start for the thread is dropped too.
 */
export function pauseListeningForThread(environmentId: string, threadId: string): void {
  pendingStart.cancelForThread(environmentId, threadId);
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
  loadedUrl = null;
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
