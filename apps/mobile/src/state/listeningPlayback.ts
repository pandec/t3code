import {
  createListeningPlaybackCoordinator,
  type ListeningPlaybackCoordinator,
} from "@t3tools/shared/listeningPlayback";
import { useSyncExternalStore } from "react";

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
  readonly restartFromBeginning: boolean;
  readonly seekToBeginning: () => Promise<void>;
  readonly prepareAudioMode: () => Promise<void>;
  readonly applyPlaybackRate: (speed: number) => void;
  readonly play: () => void;
}): Promise<void> {
  const coordinator = input.coordinator ?? listeningPlayback;
  if (!coordinator.activate(input.id, input.pause)) return;

  try {
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
