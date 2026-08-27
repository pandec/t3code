import {
  createListeningPlaybackCoordinator,
  startListeningPlayback as startListeningPlaybackShared,
  threadListeningState,
  type ListeningPlaybackCoordinator,
  type ListeningTrackRef,
  type ThreadListeningState,
} from "@t3tools/shared/listeningPlayback";
import { useCallback, useSyncExternalStore } from "react";

export const listeningPlayback = createListeningPlaybackCoordinator();
const recordingOwners = new Set<symbol>();

export function setListeningRecordingActive(owner: symbol, active: boolean): void {
  if (active) recordingOwners.add(owner);
  else recordingOwners.delete(owner);
  listeningPlayback.setBlocked(recordingOwners.size > 0);
}

type SharedStartupInput = Parameters<typeof startListeningPlaybackShared>[0];

export function startListeningPlayback(
  input: Omit<SharedStartupInput, "coordinator"> & {
    readonly coordinator?: ListeningPlaybackCoordinator;
  },
): Promise<void> {
  return startListeningPlaybackShared({
    ...input,
    coordinator: input.coordinator ?? listeningPlayback,
  });
}

export interface PendingListeningStartGate {
  /** Arms a pending start; supersedes any previous one. */
  readonly begin: (input: {
    readonly track: ListeningTrackRef;
    /** Resolves the recording's URL once; the returned function cancels the watch. */
    readonly watch: (onResolved: (url: string | null) => void) => () => void;
    readonly play: (url: string) => void;
  }) => void;
  readonly cancel: () => void;
  /** Drops the pending start when its thread was deleted. */
  readonly cancelForThread: (environmentId: string, threadId: string) => void;
  readonly getPendingSpeechId: () => string | null;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * The play-before-URL intent, owned by the controller instead of a message
 * row: tapping play on a slow link and navigating away must still start the
 * audio once the signed URL lands. A newer play supersedes it, and thread
 * deletion cancels it.
 */
export function createPendingListeningStart(): PendingListeningStartGate {
  let generation = 0;
  let pending: {
    readonly generation: number;
    readonly track: ListeningTrackRef;
    readonly cancelWatch: (() => void) | null;
  } | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const clear = () => {
    if (pending === null) return;
    const cancelWatch = pending.cancelWatch;
    pending = null;
    cancelWatch?.();
    notify();
  };

  return {
    begin: (input) => {
      clear();
      generation += 1;
      const startedGeneration = generation;
      // Armed before the watch starts: a synchronously-cached URL resolves
      // inside the watch() call and must find the pending entry in place.
      pending = { generation: startedGeneration, track: input.track, cancelWatch: null };
      notify();
      const cancelWatch = input.watch((url) => {
        if (pending === null || pending.generation !== startedGeneration) return;
        pending = null;
        notify();
        if (url !== null) input.play(url);
      });
      if (pending !== null && pending.generation === startedGeneration) {
        pending = { ...pending, cancelWatch };
      } else {
        cancelWatch();
      }
    },
    cancel: clear,
    cancelForThread: (environmentId, threadId) => {
      if (
        pending !== null &&
        pending.track.environmentId === environmentId &&
        pending.track.threadId === threadId
      ) {
        clear();
      }
    },
    getPendingSpeechId: () => pending?.track.speechId ?? null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useListeningPlaybackSnapshot() {
  return useSyncExternalStore(
    listeningPlayback.subscribe,
    listeningPlayback.getSnapshot,
    listeningPlayback.getSnapshot,
  );
}

/** Position of the loaded track. Subscribe only from the active player view. */
export function useListeningPlaybackProgress() {
  return useSyncExternalStore(
    listeningPlayback.subscribeProgress,
    listeningPlayback.getProgress,
    listeningPlayback.getProgress,
  );
}

/**
 * Indicator state for a thread-list row: "playing", "paused" while the
 * thread still owns the loaded track, or null. String snapshots bail out of
 * re-renders exactly like the previous boolean selector did.
 */
export function useThreadListeningState(
  environmentId: string,
  threadId: string,
): ThreadListeningState {
  const read = useCallback(
    () => threadListeningState(listeningPlayback.getSnapshot(), environmentId, threadId),
    [environmentId, threadId],
  );
  return useSyncExternalStore(listeningPlayback.subscribe, read, read);
}
