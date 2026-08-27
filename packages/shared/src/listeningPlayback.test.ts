import { describe, expect, it, vi } from "vite-plus/test";

import {
  clampListeningSpeed,
  createListeningPlaybackCoordinator,
  formatListeningClock,
  formatListeningSpeed,
  isThreadListeningPlaying,
  LISTENING_SPEED_PRESETS,
  listeningSpeedSpokenLabel,
  nudgeListeningSpeed,
  type ListeningTrackRef,
} from "./listeningPlayback.js";

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
});
