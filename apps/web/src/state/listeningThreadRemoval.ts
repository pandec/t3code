import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { ListeningPlaybackSnapshot } from "@t3tools/shared/listeningPlayback";
import * as Option from "effect/Option";

/**
 * Fork: pauses the loaded recording when the server takes its thread out of
 * the active shell (archived, including deferred, composer, MCP and
 * other-client archives, or deleted). Archived rows leave every surface that
 * carries the pause control, so the audio must not keep playing.
 *
 * Only the environment's own shell snapshot counts: a disconnect keeps the
 * last snapshot, and client-side filtering never touches it, so neither can
 * pause anything. The thread must have been seen active first, so a
 * recording played from an already archived thread keeps playing.
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
