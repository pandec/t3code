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

  it("registers the track and attaches the source before playing", async () => {
    const coordinator = createListeningPlaybackCoordinator();
    const order: string[] = [];
    const track = {
      environmentId: "env-1",
      threadId: "thread-1",
      messageId: "message-1",
      speechId: "speech-a",
    };

    await startListeningPlayback({
      coordinator,
      id: track.speechId,
      pause: vi.fn(),
      track,
      prepareSource: async () => {
        order.push("prepareSource");
      },
      restartFromBeginning: false,
      seekToBeginning: vi.fn(async () => undefined),
      prepareAudioMode: async () => {
        order.push("prepareAudioMode");
      },
      applyPlaybackRate: vi.fn(),
      play: () => {
        order.push("play");
      },
    });

    expect(order).toEqual(["prepareSource", "prepareAudioMode", "play"]);
    expect(coordinator.getSnapshot().track).toEqual({ ...track, playing: false });
  });

  it("stops after source attach when recording starts mid-load", async () => {
    const coordinator = createListeningPlaybackCoordinator();
    const loadStarted = deferred();
    const finishLoad = deferred();
    const prepareAudioMode = vi.fn(async () => undefined);
    const play = vi.fn();

    const startup = startListeningPlayback({
      coordinator,
      id: "speech-a",
      pause: vi.fn(),
      prepareSource: async () => {
        loadStarted.resolve();
        await finishLoad.promise;
      },
      restartFromBeginning: false,
      seekToBeginning: vi.fn(async () => undefined),
      prepareAudioMode,
      applyPlaybackRate: vi.fn(),
      play,
    });

    await loadStarted.promise;
    coordinator.setBlocked(true);
    finishLoad.resolve();
    await startup;

    expect(prepareAudioMode).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });
});
