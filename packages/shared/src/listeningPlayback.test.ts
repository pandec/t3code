import { describe, expect, it, vi } from "vite-plus/test";

import {
  clampListeningSpeed,
  createListeningPlaybackCoordinator,
  formatListeningSpeed,
  LISTENING_SPEED_PRESETS,
  listeningSpeedSpokenLabel,
  nudgeListeningSpeed,
} from "./listeningPlayback.js";

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
    expect(coordinator.activate("b", pauseB)).toBe(true);
    expect(pauseA).toHaveBeenCalledOnce();
    expect(pauseB).not.toHaveBeenCalled();
  });

  it("pauses and blocks playback while recording without auto-resuming", () => {
    const coordinator = createListeningPlaybackCoordinator();
    const pause = vi.fn();

    coordinator.activate("a", pause);
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
    expect(coordinator.getSnapshot()).toEqual({ speed: 1.3, blocked: true });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
