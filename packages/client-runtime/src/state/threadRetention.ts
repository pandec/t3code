import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

// Keep recent thread snapshots for back navigation. Live subscriptions end
// when the last detail consumer leaves.
export const THREAD_SNAPSHOT_IDLE_TTL_MS = 5 * 60_000;

export const DEFAULT_MESSAGE_WINDOW_LIMIT = 2_000;
export const DEFAULT_MESSAGE_OLDER_PAGE_SIZE = 200;
// Explicit scrollback may widen the hot window, but keep it bounded so streaming
// updates cannot rebuild an arbitrarily large message array again.
export const MAX_MESSAGE_WINDOW_MULTIPLIER = 5;

/**
 * Turn window sizes for paginated thread loads: the initial page covers the
 * last 10 user-anchored turns (subagent/fan-out turns ride along), each
 * "load earlier" tap fetches 20 more. Sized so first paint on the heaviest
 * observed threads stays around 100K gzipped while median threads load fully.
 */
export const DEFAULT_INITIAL_TURN_LIMIT = 10;
export const DEFAULT_OLDER_TURN_LIMIT = 20;

export interface ThreadHistoryWindowConfig {
  /**
   * LEGACY message-count window used only against servers that do not
   * advertise `threadSnapshotPagination`. `null` means full history.
   */
  readonly messageWindowLimit: number | null;
  /** LEGACY older-message page size (same fallback path as above). */
  readonly messageOlderPageSize: number;
  /**
   * Turns in the initial window. `null` (the default) opts this client out of
   * turn pagination entirely, so it always loads full history — that is what
   * keeps web/desktop on complete threads.
   */
  readonly initialTurnLimit?: number | null;
  /** Turns per "load earlier" page. */
  readonly olderTurnLimit?: number;
  /**
   * Soft ceiling on resident messages. It never trims loaded history and never
   * changes the server's `page.hasMore`: it only stops AUTOMATIC refills
   * (underfill/deep-revert recovery) once the thread already holds this many
   * messages. Explicit "load earlier" requests are user intent and ignore it,
   * so history is never silently unreachable. `null` means unbounded.
   */
  readonly residentMessageCeiling?: number | null;
}

export class ThreadHistoryWindow extends Context.Service<
  ThreadHistoryWindow,
  ThreadHistoryWindowConfig
>()("@t3tools/client-runtime/state/threadRetention/ThreadHistoryWindow") {}

export function threadHistoryWindowLayer(
  config: ThreadHistoryWindowConfig,
): Layer.Layer<ThreadHistoryWindow> {
  return Layer.succeed(ThreadHistoryWindow, ThreadHistoryWindow.of(config));
}
