import type { ListeningTrackRef } from "@t3tools/shared/listeningPlayback";
import { describe, expect, it, vi } from "vite-plus/test";

type StatusListener = (status: {
  readonly playing: boolean;
  readonly isBuffering: boolean;
  readonly timeControlStatus: string;
  readonly error: string | null;
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
    seekTo: async (_seconds: number) => {},
    setPlaybackRate: () => {},
    setActiveForLockScreen: (_active: boolean) => {},
    clearLockScreenControls: () => {},
    play: () => {},
    pause: (_deactivateSession?: boolean) => {},
  };
  return {
    player,
    emit: (
      playing: boolean,
      stopped: "paused" | "buffering" = "paused",
      error: string | null = null,
    ) => {
      const buffering = !playing && stopped === "buffering";
      for (const listener of listeners) {
        listener({
          playing,
          isBuffering: buffering,
          timeControlStatus: playing
            ? "playing"
            : buffering
              ? "waitingToPlayAtSpecifiedRate"
              : "paused",
          error,
          didJustFinish: false,
          currentTime: 1,
          duration: 10,
        });
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

const trackA: ListeningTrackRef = {
  environmentId: "env-1",
  threadId: "thread-1",
  messageId: "message-1",
  speechId: "speech-1",
};
const trackB: ListeningTrackRef = { ...trackA, messageId: "message-2", speechId: "speech-2" };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const play = (track: ListeningTrackRef, url: string) =>
  playListeningTrack({ track, metadata: { title: "Reply" }, url });

async function startListening() {
  await play(trackA, "https://audio/1");
  audio.emit(true);
}

/** Whether listening still holds the session: a new owner cancels it, removing lock-screen controls. */
async function listeningHeldSession() {
  using lockScreen = vi.spyOn(audio.player, "setActiveForLockScreen");
  const next = acquireAudioSession("playback");
  const held = lockScreen.mock.calls.some(([active]) => !active);
  await releaseAudioSession(next);
  return held;
}

function stop() {
  stopListeningForThread(trackA.environmentId, trackA.threadId);
}

describe("listening player audio session", () => {
  it("takes the session from inline media in background mode and yields it to a new owner", async () => {
    using playSpy = vi.spyOn(audio.player, "play");
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
    expect(playSpy).toHaveBeenCalledOnce();

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
    stop();
  });

  it("releases the session when listening is paused in the app or on the lock screen", async () => {
    await startListening();
    listeningPlayback.pauseActive();
    audio.emit(false);
    expect(await listeningHeldSession()).toBe(false);
    stop();

    await startListening();
    audio.emit(false, "buffering");
    expect(await listeningHeldSession()).toBe(true);
    stop();

    await startListening();
    audio.emit(false);
    expect(await listeningHeldSession()).toBe(false);
    stop();
  });

  it("pauses and releases the session when a lock-screen resume cannot activate it", async () => {
    await startListening();
    listeningPlayback.pauseActive();
    audio.emit(false);
    const paused = deferred();
    using pause = vi.spyOn(audio.player, "pause").mockImplementation(() => paused.resolve());
    audio.setMode.mockRejectedValueOnce(new Error("Activation failed"));
    audio.emit(true);
    await paused.promise;
    pause.mockRestore();
    expect(await listeningHeldSession()).toBe(false);
    stop();
  });

  it("keeps a newer recording's session when an older activation fails", async () => {
    using playSpy = vi.spyOn(audio.player, "play");
    const modeStarted = deferred();
    const modeResult = deferred();
    audio.setMode.mockImplementationOnce(() => {
      modeStarted.resolve();
      return modeResult.promise;
    });
    const first = play(trackA, "https://audio/1");
    await modeStarted.promise;
    const second = play(trackB, "https://audio/2");
    modeResult.reject(new Error("Activation failed"));
    await Promise.all([first, second]);
    expect(playSpy).toHaveBeenCalledOnce();
    expect(listeningPlayback.getSnapshot().track?.speechId).toBe(trackB.speechId);
    stopListeningForThread(trackB.environmentId, trackB.threadId);
  });

  it("does not retake the session from media started while the source loads", async () => {
    await play(trackA, "https://audio/1");
    listeningPlayback.pauseActive();
    using playSpy = vi.spyOn(audio.player, "play");
    audio.player.currentTime = 4;
    const seekStarted = deferred();
    const seekDone = deferred();
    using _seek = vi.spyOn(audio.player, "seekTo").mockImplementation(() => {
      seekStarted.resolve();
      return seekDone.promise;
    });
    // A re-signed URL for the loaded recording restores the position before playing.
    const refresh = play(trackA, "https://audio/1-resigned");
    await seekStarted.promise;
    const cancelInline = vi.fn();
    const inline = acquireAudioSession("playback", cancelInline);
    seekDone.resolve();
    await refresh;
    audio.player.currentTime = 0;
    expect(cancelInline).not.toHaveBeenCalled();
    expect(isAudioSessionOwner(inline)).toBe(true);
    expect(playSpy).not.toHaveBeenCalled();
    await releaseAudioSession(inline);
    stop();
  });

  it("releases the session on a lock-screen pause that follows buffering", async () => {
    await startListening();
    audio.emit(false, "buffering");
    audio.emit(false);
    expect(await listeningHeldSession()).toBe(false);
    stop();
  });

  it("keeps the session of a restart of the same recording when an earlier one completes", async () => {
    using playSpy = vi.spyOn(audio.player, "play");
    const firstModeStarted = deferred();
    const firstMode = deferred();
    const secondMode = deferred();
    audio.setMode
      .mockImplementationOnce(() => {
        firstModeStarted.resolve();
        return firstMode.promise;
      })
      .mockImplementationOnce(() => secondMode.promise);
    const first = play(trackA, "https://audio/1");
    await firstModeStarted.promise;
    const second = play(trackA, "https://audio/1");
    firstMode.resolve();
    await first;
    // A status the player sent before the restart; it carries the last start's failure.
    audio.emit(false, "paused", "Stale failure");
    secondMode.resolve();
    await second;
    expect(playSpy).toHaveBeenCalledOnce();
    stop();
  });

  it("ignores a paused status sent before the player reports playing", async () => {
    await play(trackA, "https://audio/1");
    audio.emit(false);
    expect(await listeningHeldSession()).toBe(true);
    stop();
  });
});
