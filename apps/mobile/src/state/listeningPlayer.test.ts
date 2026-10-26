import type { ListeningTrackRef } from "@t3tools/shared/listeningPlayback";
import { describe, expect, it, vi } from "vite-plus/test";

type StatusListener = (status: {
  readonly playing: boolean;
  readonly didJustFinish: boolean;
  readonly currentTime: number;
  readonly duration: number;
}) => void;

const audio = vi.hoisted(() => {
  const listeners: StatusListener[] = [];
  const player = {
    currentTime: 0,
    duration: 10,
    shouldCorrectPitch: false,
    addListener: (_event: string, listener: StatusListener) => listeners.push(listener),
    replace: () => {},
    seekTo: async () => {},
    setPlaybackRate: () => {},
    setActiveForLockScreen: () => {},
    clearLockScreenControls: () => {},
    play: () => {},
    pause: (_deactivateSession?: boolean) => {},
  };
  return {
    player,
    emit: (playing: boolean) => {
      for (const listener of listeners) {
        listener({ playing, didJustFinish: false, currentTime: 1, duration: 10 });
      }
    },
    setMode: vi.fn(async (_mode: unknown) => {}),
  };
});
vi.mock("expo-audio", () => ({
  AudioModule: {},
  createAudioPlayer: () => audio.player,
  setAudioModeAsync: audio.setMode,
  setIsAudioActiveAsync: async () => {},
}));

import {
  acquireAudioSession,
  activateAudioSession,
  isAudioSessionOwner,
  releaseAudioSession,
} from "../lib/audioSession";
import { listeningPlayback } from "./listeningPlayback";
import { playListeningTrack, stopListeningForThread } from "./listeningPlayer";

const track: ListeningTrackRef = {
  environmentId: "env-1",
  threadId: "thread-1",
  messageId: "message-1",
  speechId: "speech-1",
};

async function startListening() {
  await playListeningTrack({ track, metadata: { title: "Reply" }, url: "https://audio/1" });
  audio.emit(true);
}

describe("listening player audio session", () => {
  it("takes the session from inline media in background mode and yields it to a new owner", async () => {
    using play = vi.spyOn(audio.player, "play");
    using pause = vi.spyOn(audio.player, "pause");
    using lockScreen = vi.spyOn(audio.player, "setActiveForLockScreen");
    const cancelInline = vi.fn();
    const inline = acquireAudioSession("playback", cancelInline);
    await activateAudioSession(inline);

    await startListening();
    expect(cancelInline).toHaveBeenCalledOnce();
    expect(audio.setMode).toHaveBeenLastCalledWith(
      expect.objectContaining({ shouldPlayInBackground: true }),
    );
    expect(play).toHaveBeenCalledOnce();

    const video = acquireAudioSession("playback");
    // The new owner keeps the shared iOS session active through listening's pause.
    expect(pause).toHaveBeenLastCalledWith(false);
    expect(lockScreen).toHaveBeenLastCalledWith(false);
    audio.emit(false);
    expect(listeningPlayback.getSnapshot().track?.playing).toBe(false);

    // A status queued before the pause must not take the session back.
    audio.emit(true);
    expect(isAudioSessionOwner(video)).toBe(true);
    await releaseAudioSession(video);
    stopListeningForThread(track.environmentId, track.threadId);
  });

  it("releases the session when listening is paused", async () => {
    await startListening();
    listeningPlayback.pauseActive();
    audio.emit(false);

    using lockScreen = vi.spyOn(audio.player, "setActiveForLockScreen");
    const inline = acquireAudioSession("playback");
    expect(lockScreen).not.toHaveBeenCalled();
    await releaseAudioSession(inline);
    stopListeningForThread(track.environmentId, track.threadId);
  });
});
