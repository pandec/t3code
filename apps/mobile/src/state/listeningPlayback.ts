import {
  createListeningPlaybackCoordinator,
  isThreadListeningPlaying,
  type ListeningPlaybackCoordinator,
  type ListeningTrackRef,
} from "@t3tools/shared/listeningPlayback";
import { useCallback, useSyncExternalStore } from "react";

export const listeningPlayback = createListeningPlaybackCoordinator();
const recordingOwners = new Set<symbol>();

export function setListeningRecordingActive(owner: symbol, active: boolean): void {
  if (active) recordingOwners.add(owner);
  else recordingOwners.delete(owner);
  listeningPlayback.setBlocked(recordingOwners.size > 0);
}

export async function startListeningPlayback(input: {
  readonly coordinator?: ListeningPlaybackCoordinator;
  readonly id: string;
  readonly pause: () => void;
  /** Registers the recording with the coordinator so thread lists can point at it. */
  readonly track?: ListeningTrackRef;
  /** Attaches or swaps the player's source before playback starts. */
  readonly prepareSource?: () => Promise<void>;
  readonly restartFromBeginning: boolean;
  readonly seekToBeginning: () => Promise<void>;
  readonly prepareAudioMode: () => Promise<void>;
  readonly applyPlaybackRate: (speed: number) => void;
  readonly play: () => void;
}): Promise<void> {
  const coordinator = input.coordinator ?? listeningPlayback;
  if (!coordinator.activate(input.id, input.pause, input.track)) return;

  try {
    if (input.prepareSource !== undefined) {
      await input.prepareSource();
      if (coordinator.getSnapshot().blocked || !coordinator.isActive(input.id, input.pause)) return;
    }
    if (input.restartFromBeginning) await input.seekToBeginning();
    if (coordinator.getSnapshot().blocked || !coordinator.isActive(input.id, input.pause)) return;

    await input.prepareAudioMode();
    const snapshot = coordinator.getSnapshot();
    if (snapshot.blocked || !coordinator.isActive(input.id, input.pause)) return;

    input.applyPlaybackRate(snapshot.speed);
    input.play();
  } catch {
    coordinator.release(input.id, input.pause);
  }
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

/** Whether the thread owns the actively playing audio; drives list indicators. */
export function useThreadListeningPlaying(environmentId: string, threadId: string): boolean {
  const read = useCallback(
    () => isThreadListeningPlaying(listeningPlayback.getSnapshot(), environmentId, threadId),
    [environmentId, threadId],
  );
  return useSyncExternalStore(listeningPlayback.subscribe, read, read);
}
