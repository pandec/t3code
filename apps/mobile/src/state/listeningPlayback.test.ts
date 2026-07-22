import { createListeningPlaybackCoordinator } from "@t3tools/shared/listeningPlayback";
import { describe, expect, it, vi } from "vite-plus/test";

import { startListeningPlayback } from "./listeningPlayback";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("mobile listening playback startup", () => {
  it("does not change audio mode when recording starts during an end-of-track seek", async () => {
    const coordinator = createListeningPlaybackCoordinator();
    const seekStarted = deferred();
    const finishSeek = deferred();
    const pause = vi.fn();
    const prepareAudioMode = vi.fn(async () => undefined);
    const play = vi.fn();

    const startup = startListeningPlayback({
      coordinator,
      id: "speech-a",
      pause,
      restartFromBeginning: true,
      seekToBeginning: async () => {
        seekStarted.resolve();
        await finishSeek.promise;
      },
      prepareAudioMode,
      applyPlaybackRate: vi.fn(),
      play,
    });

    await seekStarted.promise;
    coordinator.setBlocked(true);
    finishSeek.resolve();
    await startup;

    expect(pause).toHaveBeenCalledOnce();
    expect(prepareAudioMode).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it("does not resume a stale player after a newer row takes ownership", async () => {
    const coordinator = createListeningPlaybackCoordinator();
    const audioModeStarted = deferred();
    const finishAudioMode = deferred();
    const pauseA = vi.fn();
    const playA = vi.fn();
    const playB = vi.fn();

    const startupA = startListeningPlayback({
      coordinator,
      id: "speech-a",
      pause: pauseA,
      restartFromBeginning: false,
      seekToBeginning: vi.fn(async () => undefined),
      prepareAudioMode: async () => {
        audioModeStarted.resolve();
        await finishAudioMode.promise;
      },
      applyPlaybackRate: vi.fn(),
      play: playA,
    });

    await audioModeStarted.promise;
    await startListeningPlayback({
      coordinator,
      id: "speech-b",
      pause: vi.fn(),
      restartFromBeginning: false,
      seekToBeginning: vi.fn(async () => undefined),
      prepareAudioMode: vi.fn(async () => undefined),
      applyPlaybackRate: vi.fn(),
      play: playB,
    });
    finishAudioMode.resolve();
    await startupA;

    expect(pauseA).toHaveBeenCalledOnce();
    expect(playA).not.toHaveBeenCalled();
    expect(playB).toHaveBeenCalledOnce();
  });

  it("applies the latest speed after asynchronous audio setup", async () => {
    const coordinator = createListeningPlaybackCoordinator();
    const audioModeStarted = deferred();
    const finishAudioMode = deferred();
    const applyPlaybackRate = vi.fn();

    const startup = startListeningPlayback({
      coordinator,
      id: "speech-a",
      pause: vi.fn(),
      restartFromBeginning: false,
      seekToBeginning: vi.fn(async () => undefined),
      prepareAudioMode: async () => {
        audioModeStarted.resolve();
        await finishAudioMode.promise;
      },
      applyPlaybackRate,
      play: vi.fn(),
    });

    await audioModeStarted.promise;
    coordinator.setSpeed(1.75);
    finishAudioMode.resolve();
    await startup;

    expect(applyPlaybackRate).toHaveBeenCalledWith(1.75);
  });
});
