import {
  createListeningPlaybackCoordinator,
  type ListeningTrackRef,
} from "@t3tools/shared/listeningPlayback";
import { describe, expect, it, vi } from "vite-plus/test";

import { createPendingListeningStart, startListeningPlayback } from "./listeningPlayback";

const pendingTrack: ListeningTrackRef = {
  environmentId: "env-1",
  threadId: "thread-1",
  messageId: "message-1",
  speechId: "speech-a",
};

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

describe("pending listening start", () => {
  it("plays once the URL lands, even without the row that armed it", () => {
    const gate = createPendingListeningStart();
    const play = vi.fn();
    let deliver: (url: string | null) => void = () => undefined;

    gate.begin({
      track: pendingTrack,
      watch: (onResolved) => {
        deliver = onResolved;
        return vi.fn();
      },
      play,
    });
    expect(gate.getPendingSpeechId()).toBe("speech-a");

    deliver("https://example.test/a.mp3");
    expect(play).toHaveBeenCalledWith("https://example.test/a.mp3");
    expect(gate.getPendingSpeechId()).toBeNull();
  });

  it("plays a URL that resolves synchronously inside the watch", () => {
    const gate = createPendingListeningStart();
    const play = vi.fn();

    gate.begin({
      track: pendingTrack,
      watch: (onResolved) => {
        onResolved("https://example.test/a.mp3");
        return vi.fn();
      },
      play,
    });

    expect(play).toHaveBeenCalledOnce();
    expect(gate.getPendingSpeechId()).toBeNull();
  });

  it("supersedes an armed start with a newer one and cancels its watch", () => {
    const gate = createPendingListeningStart();
    const cancelFirstWatch = vi.fn();
    const playFirst = vi.fn();
    const playSecond = vi.fn();
    let deliverFirst: (url: string | null) => void = () => undefined;
    let deliverSecond: (url: string | null) => void = () => undefined;

    gate.begin({
      track: pendingTrack,
      watch: (onResolved) => {
        deliverFirst = onResolved;
        return cancelFirstWatch;
      },
      play: playFirst,
    });
    gate.begin({
      track: { ...pendingTrack, threadId: "thread-2", speechId: "speech-b" },
      watch: (onResolved) => {
        deliverSecond = onResolved;
        return vi.fn();
      },
      play: playSecond,
    });

    expect(cancelFirstWatch).toHaveBeenCalledOnce();
    deliverFirst("https://example.test/a.mp3");
    expect(playFirst).not.toHaveBeenCalled();
    deliverSecond("https://example.test/b.mp3");
    expect(playSecond).toHaveBeenCalledOnce();
  });

  it("cancels for the deleted thread and only for it", () => {
    const gate = createPendingListeningStart();
    const cancelWatch = vi.fn();
    const play = vi.fn();
    let deliver: (url: string | null) => void = () => undefined;

    gate.begin({
      track: pendingTrack,
      watch: (onResolved) => {
        deliver = onResolved;
        return cancelWatch;
      },
      play,
    });
    gate.cancelForThread("env-1", "thread-other");
    expect(gate.getPendingSpeechId()).toBe("speech-a");

    gate.cancelForThread("env-1", "thread-1");
    expect(cancelWatch).toHaveBeenCalledOnce();
    expect(gate.getPendingSpeechId()).toBeNull();
    deliver("https://example.test/a.mp3");
    expect(play).not.toHaveBeenCalled();
  });

  it("does not play when resolution fails, and notifies subscribers", () => {
    const gate = createPendingListeningStart();
    const listener = vi.fn();
    const play = vi.fn();
    let deliver: (url: string | null) => void = () => undefined;
    gate.subscribe(listener);

    gate.begin({
      track: pendingTrack,
      watch: (onResolved) => {
        deliver = onResolved;
        return vi.fn();
      },
      play,
    });
    expect(listener).toHaveBeenCalledOnce();

    deliver(null);
    expect(play).not.toHaveBeenCalled();
    expect(gate.getPendingSpeechId()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
