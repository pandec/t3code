import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { createListeningPlaybackCoordinator } from "@t3tools/shared/listeningPlayback";
import type { OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

import { watchListeningThreadRemoval } from "./listeningThreadRemoval";

const track = {
  environmentId: "env",
  threadId: "thread",
  messageId: "message",
  speechId: "speech",
};

function shellState(threadIds: ReadonlyArray<string> | null): EnvironmentShellState {
  return {
    snapshot:
      threadIds === null
        ? Option.none()
        : Option.some({
            threads: threadIds.map((id) => ({ id })),
          } as unknown as OrchestrationV2ShellSnapshot),
    status: "live",
    error: Option.none(),
  };
}

function setup(initial: EnvironmentShellState) {
  const playback = createListeningPlaybackCoordinator();
  const listeners = new Set<(state: EnvironmentShellState) => void>();
  const pause = vi.fn();
  const stop = watchListeningThreadRemoval({
    playback,
    subscribeShell: (_environmentId, listener) => {
      listeners.add(listener);
      listener(initial);
      return () => listeners.delete(listener);
    },
    pause,
  });
  const emit = (state: EnvironmentShellState) => {
    for (const listener of listeners) listener(state);
  };
  return { playback, pause, emit, stop, listeners };
}

describe("watchListeningThreadRemoval", () => {
  it("pauses the loaded recording when a deferred archive takes its thread off the active shell", () => {
    const { playback, pause, emit } = setup(shellState(["thread"]));
    playback.activate(track.speechId, () => {}, track);
    playback.setTrackPlaying(true);
    emit(shellState(["thread", "other"]));
    expect(pause).not.toHaveBeenCalled();
    emit(shellState(["other"]));
    expect(pause).toHaveBeenCalledExactlyOnceWith("env", "thread");
  });

  it("ignores a disconnect without a snapshot and threads it never saw active", () => {
    const { playback, pause, emit } = setup(shellState([]));
    playback.activate(track.speechId, () => {}, track);
    emit(shellState(null));
    emit(shellState([]));
    expect(pause).not.toHaveBeenCalled();
  });

  it("stops watching once the recording is unloaded", () => {
    const { playback, pause, emit, listeners } = setup(shellState(["thread"]));
    playback.activate(track.speechId, () => {}, track);
    expect(listeners.size).toBe(1);
    playback.setTrack(null);
    expect(listeners.size).toBe(0);
    emit(shellState([]));
    expect(pause).not.toHaveBeenCalled();
  });
});
