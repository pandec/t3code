import type { ListeningTrackRef } from "@t3tools/shared/listeningPlayback";
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";

import { listeningPlayback, startListeningPlayback } from "./listeningPlayback";

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
 * recording is swapped in with the position restored, which covers token
 * expiry across long pauses without a dedicated refresh path.
 */
export async function playListeningTrack(input: {
  readonly track: ListeningTrackRef;
  readonly url: string;
}): Promise<void> {
  const player = ensureSharedPlayer();
  const previous = listeningPlayback.getSnapshot().track;
  const sameTrack = previous !== null && previous.speechId === input.track.speechId;
  const sameSource = sameTrack && loadedUrl === input.url;
  const atEnd = sameSource && player.duration > 0 && player.currentTime >= player.duration - 0.1;

  await startListeningPlayback({
    id: input.track.speechId,
    pause: pauseSharedPlayer,
    track: input.track,
    prepareSource: sameSource
      ? undefined
      : async () => {
          const resumeAt = sameTrack ? player.currentTime : 0;
          appliedSpeed = null;
          player.replace(input.url);
          loadedUrl = input.url;
          if (resumeAt > 0) await player.seekTo(resumeAt);
        },
    restartFromBeginning: atEnd,
    seekToBeginning: () => player.seekTo(0),
    prepareAudioMode: () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }),
    applyPlaybackRate: (speed) => {
      appliedSpeed = null;
      applySharedPlaybackRate(speed);
    },
    play: () => player.play(),
  });
}
