import { describe, expect, it, vi } from "vite-plus/test";

import {
  clampListeningSpeed,
  createListeningPlaybackCoordinator,
  formatListeningClock,
  formatListeningSpeed,
  isThreadListeningLoaded,
  isThreadListeningPlaying,
  LISTENING_SPEED_PRESETS,
  listeningSpeedSpokenLabel,
  nudgeListeningSpeed,
  pauseThreadListening,
  planListeningTrackStart,
  startListeningPlayback,
  threadListeningState,
  type ListeningTrackMetadata,
  type ListeningTrackRef,
} from "./listeningPlayback.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const trackA: ListeningTrackRef = {
  environmentId: "env-1",
  threadId: "thread-1",
  messageId: "message-1",
  speechId: "speech-a",
};

const trackB: ListeningTrackRef = {
  environmentId: "env-1",
  threadId: "thread-2",
  messageId: "message-2",
  speechId: "speech-b",
};

const trackMetadata: ListeningTrackMetadata = { title: "Thread one" };

describe("listening playback speed", () => {
  it("clamps and snaps values to the 0.05 grid", () => {
    expect(clampListeningSpeed(0.9)).toBe(1);
    expect(clampListeningSpeed(1.23)).toBe(1.25);
    expect(clampListeningSpeed(2.0000000000000004)).toBe(2);
    expect(clampListeningSpeed(Number.NaN)).toBe(1);
  });

  it("nudges without accumulating floating-point drift", () => {
    let speed = 1;
    for (let index = 0; index < 20; index += 1) speed = nudgeListeningSpeed(speed, 1);
    expect(speed).toBe(2);
    expect(nudgeListeningSpeed(speed, 1)).toBe(2);
    for (let index = 0; index < 20; index += 1) speed = nudgeListeningSpeed(speed, -1);
    expect(speed).toBe(1);
  });

  it("keeps every preset in range and formats visible and spoken labels", () => {
    expect(LISTENING_SPEED_PRESETS.every((speed) => speed >= 1 && speed <= 2)).toBe(true);
    expect(formatListeningSpeed(1.5)).toBe("1.50×");
    expect(listeningSpeedSpokenLabel(1.5)).toBe("1.5 times");
  });
});

describe("listening playback coordinator", () => {
  it("pauses the previous player when another becomes active", () => {
    const coordinator = createListeningPlaybackCoordinator();
    const pauseA = vi.fn();
    const pauseB = vi.fn();

    expect(coordinator.activate("a", pauseA)).toBe(true);
    expect(coordinator.isActive("a", pauseA)).toBe(true);
    expect(coordinator.activate("b", pauseB)).toBe(true);
    expect(coordinator.isActive("a", pauseA)).toBe(false);
    expect(coordinator.isActive("b", pauseB)).toBe(true);
    expect(pauseA).toHaveBeenCalledOnce();
    expect(pauseB).not.toHaveBeenCalled();
  });

  it("pauses and blocks playback while recording without auto-resuming", () => {
    const coordinator = createListeningPlaybackCoordinator();
    const pause = vi.fn();

    coordinator.activate("a", pause);
    coordinator.setBlocked(true);
    coordinator.setBlocked(true);
    expect(pause).toHaveBeenCalledOnce();
    expect(coordinator.activate("b", vi.fn())).toBe(false);
    coordinator.setBlocked(false);
    expect(pause).toHaveBeenCalledOnce();
    expect(coordinator.activate("b", vi.fn())).toBe(true);
  });

  it("does not let a stale row release a replacement player with the same id", () => {
    const coordinator = createListeningPlaybackCoordinator();
    const stalePause = vi.fn();
    const currentPause = vi.fn();

    coordinator.activate("a", stalePause);
    coordinator.activate("a", currentPause);
    coordinator.release("a", stalePause);
    expect(coordinator.isActive("a", currentPause)).toBe(true);
    coordinator.pauseActive();
    expect(currentPause).toHaveBeenCalledOnce();
  });

  it("publishes normalized speed and blocked changes", () => {
    const coordinator = createListeningPlaybackCoordinator();
    const listener = vi.fn();
    coordinator.subscribe(listener);

    coordinator.setSpeed(1.23);
    coordinator.nudgeSpeed(1);
    coordinator.setBlocked(true);
    expect(coordinator.getSnapshot()).toEqual({ speed: 1.3, blocked: true, track: null });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe("listening playback active track", () => {
  it("keeps display metadata outside the list-facing track snapshot", () => {
    const coordinator = createListeningPlaybackCoordinator();
    const trackWithMetadata = { ...trackA, ...trackMetadata };
    coordinator.setTrack(trackWithMetadata);

    expect(coordinator.getSnapshot().track).not.toHaveProperty("title");
  });

  it("tracks the active recording through activation and playback flips", () => {
    const coordinator = createListeningPlaybackCoordinator();
    const listener = vi.fn();
    coordinator.subscribe(listener);

    expect(coordinator.activate(trackA.speechId, vi.fn(), trackA)).toBe(true);
    expect(coordinator.getSnapshot().track).toEqual({ ...trackA, playing: false });
    coordinator.setTrackPlaying(true);
    expect(coordinator.getSnapshot().track).toEqual({ ...trackA, playing: true });
    coordinator.setTrackPlaying(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the playing flag when the loaded recording is re-activated", () => {
    const coordinator = createListeningPlaybackCoordinator();
    coordinator.activate(trackA.speechId, vi.fn(), trackA);
    coordinator.setTrackPlaying(true);
    coordinator.activate(trackA.speechId, vi.fn(), trackA);
    expect(coordinator.getSnapshot().track).toEqual({ ...trackA, playing: true });
  });

  it("replaces the track and resets progress when another recording activates", () => {
    const coordinator = createListeningPlaybackCoordinator();
    const pauseA = vi.fn();
    coordinator.activate(trackA.speechId, pauseA, trackA);
    coordinator.setTrackPlaying(true);
    coordinator.setProgress({ currentTime: 12, duration: 60 });

    coordinator.activate(trackB.speechId, vi.fn(), trackB);
    expect(pauseA).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().track).toEqual({ ...trackB, playing: false });
    expect(coordinator.getProgress()).toEqual({ currentTime: 0, duration: 0 });
  });

  it("does not adopt a track when playback is blocked", () => {
    const coordinator = createListeningPlaybackCoordinator();
    coordinator.setBlocked(true);
    expect(coordinator.activate(trackA.speechId, vi.fn(), trackA)).toBe(false);
    expect(coordinator.getSnapshot().track).toBeNull();
  });

  it("notifies progress listeners without waking snapshot listeners", () => {
    const coordinator = createListeningPlaybackCoordinator();
    coordinator.activate(trackA.speechId, vi.fn(), trackA);
    const snapshotListener = vi.fn();
    const progressListener = vi.fn();
    coordinator.subscribe(snapshotListener);
    coordinator.subscribeProgress(progressListener);

    coordinator.setProgress({ currentTime: 1, duration: 60 });
    coordinator.setProgress({ currentTime: 1, duration: 60 });
    expect(progressListener).toHaveBeenCalledOnce();
    expect(snapshotListener).not.toHaveBeenCalled();
  });

  it("pauses on archive only when the thread owns the loaded track", () => {
    const coordinator = createListeningPlaybackCoordinator();
    const pause = vi.fn();
    coordinator.activate(trackA.speechId, pause, trackA);
    coordinator.setTrackPlaying(true);

    pauseThreadListening(coordinator, "env-1", "thread-other");
    expect(pause).not.toHaveBeenCalled();

    pauseThreadListening(coordinator, trackA.environmentId, trackA.threadId);
    expect(pause).toHaveBeenCalledOnce();
    // Paused, not cleared: the recording stays loaded and resumable.
    expect(coordinator.getSnapshot().track).toEqual({ ...trackA, playing: true });
  });

  it("resolves the now-playing indicator only for the playing thread", () => {
    const coordinator = createListeningPlaybackCoordinator();
    expect(isThreadListeningPlaying(coordinator.getSnapshot(), "env-1", "thread-1")).toBe(false);

    coordinator.activate(trackA.speechId, vi.fn(), trackA);
    expect(isThreadListeningPlaying(coordinator.getSnapshot(), "env-1", "thread-1")).toBe(false);

    coordinator.setTrackPlaying(true);
    expect(isThreadListeningPlaying(coordinator.getSnapshot(), "env-1", "thread-1")).toBe(true);
    expect(isThreadListeningPlaying(coordinator.getSnapshot(), "env-1", "thread-2")).toBe(false);
    expect(isThreadListeningPlaying(coordinator.getSnapshot(), "env-2", "thread-1")).toBe(false);

    coordinator.setTrackPlaying(false);
    expect(isThreadListeningPlaying(coordinator.getSnapshot(), "env-1", "thread-1")).toBe(false);
  });

  it("formats playback clocks defensively", () => {
    expect(formatListeningClock(0)).toBe("0:00");
    expect(formatListeningClock(65.9)).toBe("1:05");
    expect(formatListeningClock(Number.NaN)).toBe("0:00");
  });

  it("reports loaded and paused states for the indicator toggle", () => {
    const coordinator = createListeningPlaybackCoordinator();
    expect(threadListeningState(coordinator.getSnapshot(), "env-1", "thread-1")).toBeNull();
    expect(isThreadListeningLoaded(coordinator.getSnapshot(), "env-1", "thread-1")).toBe(false);

    coordinator.activate(trackA.speechId, vi.fn(), trackA);
    expect(threadListeningState(coordinator.getSnapshot(), "env-1", "thread-1")).toBe("paused");
    expect(isThreadListeningLoaded(coordinator.getSnapshot(), "env-1", "thread-1")).toBe(true);
    expect(threadListeningState(coordinator.getSnapshot(), "env-1", "thread-2")).toBeNull();

    coordinator.setTrackPlaying(true);
    expect(threadListeningState(coordinator.getSnapshot(), "env-1", "thread-1")).toBe("playing");

    coordinator.setTrackPlaying(false);
    expect(threadListeningState(coordinator.getSnapshot(), "env-1", "thread-1")).toBe("paused");

    coordinator.setTrack(null);
    expect(threadListeningState(coordinator.getSnapshot(), "env-1", "thread-1")).toBeNull();
  });
});

describe("listening track start plan", () => {
  it("resumes the loaded recording in place regardless of source URL", () => {
    expect(
      planListeningTrackStart({
        loadedTrack: trackA,
        nextTrack: trackA,
        positionSeconds: 12.5,
        durationSeconds: 60,
      }),
    ).toEqual({ sameTrack: true, finished: false, resumeAt: 12.5 });
  });

  it("classifies end-of-track by identity so a re-signed URL replays from zero", () => {
    expect(
      planListeningTrackStart({
        loadedTrack: trackA,
        nextTrack: trackA,
        positionSeconds: 59.95,
        durationSeconds: 60,
      }),
    ).toEqual({ sameTrack: true, finished: true, resumeAt: 0 });
  });

  it("starts a different recording from the beginning", () => {
    expect(
      planListeningTrackStart({
        loadedTrack: trackA,
        nextTrack: trackB,
        positionSeconds: 30,
        durationSeconds: 60,
      }),
    ).toEqual({ sameTrack: false, finished: false, resumeAt: 0 });
    expect(
      planListeningTrackStart({
        loadedTrack: null,
        nextTrack: trackA,
        positionSeconds: 30,
        durationSeconds: 60,
      }),
    ).toEqual({ sameTrack: false, finished: false, resumeAt: 0 });
  });

  it("treats an unknown duration as not finished", () => {
    expect(
      planListeningTrackStart({
        loadedTrack: trackA,
        nextTrack: trackA,
        positionSeconds: 4,
        durationSeconds: Number.NaN,
      }),
    ).toEqual({ sameTrack: true, finished: false, resumeAt: 4 });
  });
});

describe("listening playback startup generations", () => {
  it("aborts a stale startup attempt for the same recording", async () => {
    const coordinator = createListeningPlaybackCoordinator();
    const pause = vi.fn();
    const firstAudioModeStarted = deferred();
    const finishFirstAudioMode = deferred();
    const playFirst = vi.fn();
    const playSecond = vi.fn();

    // First attempt stalls in audio-mode preparation.
    const first = startListeningPlayback({
      coordinator,
      id: trackA.speechId,
      pause,
      track: trackA,
      restartFromBeginning: false,
      seekToBeginning: vi.fn(async () => undefined),
      prepareAudioMode: async () => {
        firstAudioModeStarted.resolve();
        await finishFirstAudioMode.promise;
      },
      applyPlaybackRate: vi.fn(),
      play: playFirst,
    });
    await firstAudioModeStarted.promise;

    // Second attempt for the SAME recording (same owner id and pause) completes.
    await startListeningPlayback({
      coordinator,
      id: trackA.speechId,
      pause,
      track: trackA,
      restartFromBeginning: false,
      seekToBeginning: vi.fn(async () => undefined),
      prepareAudioMode: vi.fn(async () => undefined),
      applyPlaybackRate: vi.fn(),
      play: playSecond,
    });
    expect(playSecond).toHaveBeenCalledOnce();

    // The user pauses; the stale first attempt must not resume playback.
    coordinator.pauseActive();
    finishFirstAudioMode.resolve();
    await first;
    expect(playFirst).not.toHaveBeenCalled();
  });

  it("does not let a stale rejecting attempt release the newer attempt's ownership", async () => {
    const coordinator = createListeningPlaybackCoordinator();
    const pause = vi.fn();
    const firstAudioModeStarted = deferred();
    const failFirstAudioMode = deferred();

    const first = startListeningPlayback({
      coordinator,
      id: trackA.speechId,
      pause,
      track: trackA,
      restartFromBeginning: false,
      seekToBeginning: vi.fn(async () => undefined),
      prepareAudioMode: async () => {
        firstAudioModeStarted.resolve();
        await failFirstAudioMode.promise;
        throw new Error("stale attempt failed");
      },
      applyPlaybackRate: vi.fn(),
      play: vi.fn(),
    });
    await firstAudioModeStarted.promise;

    // A newer attempt for the same recording completes and plays.
    await startListeningPlayback({
      coordinator,
      id: trackA.speechId,
      pause,
      track: trackA,
      restartFromBeginning: false,
      seekToBeginning: vi.fn(async () => undefined),
      prepareAudioMode: vi.fn(async () => undefined),
      applyPlaybackRate: vi.fn(),
      play: vi.fn(),
    });
    coordinator.setTrackPlaying(true);

    failFirstAudioMode.resolve();
    await first;
    // Ownership and track survive: recording-block pauses must still reach
    // the player, and the lists must still show the playing indicator.
    expect(coordinator.getSnapshot().track).toEqual({ ...trackA, playing: true });
    coordinator.pauseActive();
    expect(pause).toHaveBeenCalledOnce();
  });

  it("releases ownership and clears the track when the current attempt fails", async () => {
    const coordinator = createListeningPlaybackCoordinator();
    const pause = vi.fn();

    await startListeningPlayback({
      coordinator,
      id: trackA.speechId,
      pause,
      track: trackA,
      restartFromBeginning: false,
      seekToBeginning: vi.fn(async () => undefined),
      prepareAudioMode: vi.fn(async () => {
        throw new Error("audio mode failed");
      }),
      applyPlaybackRate: vi.fn(),
      play: vi.fn(),
    });

    // No dead paused indicator: the failed start unregistered its track.
    expect(coordinator.getSnapshot().track).toBeNull();
    coordinator.pauseActive();
    expect(pause).not.toHaveBeenCalled();
  });

  it("aborts a startup attempt when ownership was released mid-flight", async () => {
    const coordinator = createListeningPlaybackCoordinator();
    const pause = vi.fn();
    const sourceStarted = deferred();
    const finishSource = deferred();
    const play = vi.fn();

    const startup = startListeningPlayback({
      coordinator,
      id: trackA.speechId,
      pause,
      track: trackA,
      prepareSource: async () => {
        sourceStarted.resolve();
        await finishSource.promise;
      },
      restartFromBeginning: false,
      seekToBeginning: vi.fn(async () => undefined),
      prepareAudioMode: vi.fn(async () => undefined),
      applyPlaybackRate: vi.fn(),
      play,
    });
    await sourceStarted.promise;
    // Thread deletion releases ownership and clears the track.
    coordinator.release(trackA.speechId, pause);
    coordinator.setTrack(null);
    finishSource.resolve();
    await startup;
    expect(play).not.toHaveBeenCalled();
  });
});
