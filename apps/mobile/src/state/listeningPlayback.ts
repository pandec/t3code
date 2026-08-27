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
 * A pending intent that outlives its usefulness must expire rather than fire
 * surprise audio much later: one minute comfortably covers a slow asset RPC,
 * and anything slower (an environment mid-disconnect, hours offline) should
 * require a fresh tap. The cap also covers the disconnect case, so no
 * separate cancel-on-disconnect wiring exists.
 */
export const PENDING_LISTENING_START_TTL_MS = 60_000;

/**
 * The play-before-URL intent, owned by the controller instead of a message
 * row: tapping play on a slow link and navigating away must still start the
 * audio once the signed URL lands. A newer play supersedes it, thread
 * deletion or archival cancels it, becoming blocked (recording) cancels it,
 * and it expires after the TTL.
 */
export function createPendingListeningStart(options?: {
  /** Refuses to arm while blocked and cancels when blocking starts. */
  readonly coordinator?: ListeningPlaybackCoordinator;
  readonly ttlMs?: number;
}): PendingListeningStartGate {
  const coordinator = options?.coordinator ?? null;
  const ttlMs = options?.ttlMs ?? PENDING_LISTENING_START_TTL_MS;
  let generation = 0;
  let pending: {
    readonly generation: number;
    readonly track: ListeningTrackRef;
    readonly cancelWatch: (() => void) | null;
  } | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const clearExpiryTimer = () => {
    if (expiryTimer === null) return;
    clearTimeout(expiryTimer);
    expiryTimer = null;
  };

  const clear = () => {
    clearExpiryTimer();
    if (pending === null) return;
    const cancelWatch = pending.cancelWatch;
    pending = null;
    cancelWatch?.();
    notify();
  };

  // Recording blocks playback without auto-resume; a pending start firing
  // mid-recording (or after it) would be exactly that auto-resume.
  coordinator?.subscribe(() => {
    if (coordinator.getSnapshot().blocked) clear();
  });

  return {
    begin: (input) => {
      clear();
      if (coordinator !== null && coordinator.getSnapshot().blocked) return;
      generation += 1;
      const startedGeneration = generation;
      // Armed before the watch starts: a synchronously-cached URL resolves
      // inside the watch() call and must find the pending entry in place.
      pending = { generation: startedGeneration, track: input.track, cancelWatch: null };
      expiryTimer = setTimeout(clear, ttlMs);
      notify();
      const cancelWatch = input.watch((url) => {
        if (pending === null || pending.generation !== startedGeneration) return;
        clearExpiryTimer();
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
