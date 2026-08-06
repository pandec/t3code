import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

// Mobile thread routes unmount during back navigation. Retain the stream-backed
// state across short subscriber gaps without keeping every opened thread alive.
export const THREAD_STATE_IDLE_TTL_MS = 5 * 60_000;

export const DEFAULT_MESSAGE_WINDOW_LIMIT = 2_000;
export const DEFAULT_MESSAGE_OLDER_PAGE_SIZE = 200;

export interface ThreadHistoryWindowConfig {
  readonly messageWindowLimit: number | null;
  readonly messageOlderPageSize: number;
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
