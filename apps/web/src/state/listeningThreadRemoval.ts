import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { ListeningPlaybackSnapshot } from "@t3tools/shared/listeningPlayback";
import * as Option from "effect/Option";

/**
 * Pauses the loaded recording when the server removes its thread from the active shell
 * (any archive or delete), since archived rows lose every pause control. Only the
 * environment's own shell snapshot counts, so disconnects and client filters never pause,
 * and the thread must be seen active first, so already archived recordings keep playing.
 */
export function watchListeningThreadRemoval(input: {
  readonly playback: {
    readonly getSnapshot: () => ListeningPlaybackSnapshot;
    readonly subscribe: (listener: () => void) => () => void;
  };
  readonly subscribeShell: (
    environmentId: string,
    listener: (state: EnvironmentShellState) => void,
  ) => () => void;
  readonly pause: (environmentId: string, threadId: string) => void;
}): () => void {
  let watched: { readonly key: string; readonly unsubscribe: () => void } | null = null;

  const sync = () => {
    const track = input.playback.getSnapshot().track;
    const key = track === null ? null : `${track.environmentId}\u0000${track.threadId}`;
    if (watched?.key === key) return;
    watched?.unsubscribe();
    watched = null;
    if (track === null || key === null) return;
    const { environmentId, threadId } = track;
    let seenActive = false;
    const unsubscribe = input.subscribeShell(environmentId, (state) => {
      if (Option.isNone(state.snapshot)) return;
      const active = state.snapshot.value.threads.some((thread) => thread.id === threadId);
      if (active) {
        seenActive = true;
      } else if (seenActive) {
        seenActive = false;
        input.pause(environmentId, threadId);
      }
    });
    watched = { key, unsubscribe };
  };

  const unsubscribePlayback = input.playback.subscribe(sync);
  sync();
  return () => {
    unsubscribePlayback();
    watched?.unsubscribe();
    watched = null;
  };
}
