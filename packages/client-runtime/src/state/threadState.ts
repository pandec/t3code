import type { OrchestrationThread } from "@t3tools/contracts";
import * as Option from "effect/Option";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

/**
 * UI-facing state for the "load earlier history" action, shared by both
 * history-paging modes (turn windows and the legacy message window). Kept
 * separate from `page` because the mobile feed latches on `settledCount`: React
 * can batch adjacent publications into one commit, so a transient
 * `isLoading: true -> false` is not a reliable "attempt finished" signal, while
 * a monotonic counter always is.
 */
export interface ThreadOlderMessagesState {
  readonly isLoading: boolean;
  readonly error: string | null;
  /** Monotonic signal for every completed older-history request attempt. */
  readonly settledCount: number;
}

/**
 * Pagination state for a turn-windowed thread. Present only when the loaded
 * thread is a window (the server returned `page` metadata); absent means the
 * thread is fully loaded — either the server predates pagination, this client
 * did not request a window, or the window reached the top.
 */
export interface EnvironmentThreadPageState {
  /** Opaque exclusive cursor for the next older slice; null when fully loaded. */
  readonly beforeCursor: string | null;
  readonly hasMore: boolean;
  /**
   * True while an older page fetch is in flight. Mirrors
   * `olderMessages.isLoading` so page-aware UI can read a single object.
   */
  readonly loadingOlder: boolean;
}

/**
 * How an older-history request was triggered. `automatic: true` marks requests
 * the app made on the user's behalf (mobile underfill recovery, deep-revert
 * refill); those observe the client's soft resident-message ceiling. Explicit
 * user-driven scrollback omits it and is never capped.
 */
export interface ThreadLoadOlderHistoryOptions {
  readonly automatic?: boolean;
}

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationThread>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /** Turn-window pagination state; `none` when the thread is not windowed. */
  readonly page: Option.Option<EnvironmentThreadPageState>;
  readonly olderMessages: ThreadOlderMessagesState;
}

export const EMPTY_THREAD_OLDER_MESSAGES_STATE: ThreadOlderMessagesState = {
  isLoading: false,
  error: null,
  settledCount: 0,
};

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  page: Option.none(),
  olderMessages: EMPTY_THREAD_OLDER_MESSAGES_STATE,
};

/** Whether the thread has older turns that can be loaded with more pages. */
export function threadHasOlderTurns(state: EnvironmentThreadState): boolean {
  return Option.match(state.page, {
    onNone: () => false,
    onSome: (page) => page.hasMore,
  });
}

/**
 * Whether more history can be loaded, in either paging mode: a turn window with
 * `hasMore`, or the LEGACY message window's `hasMoreOlder` when connected to a
 * server that does not advertise `threadSnapshotPagination`.
 */
export function threadHasOlderHistory(state: EnvironmentThreadState): boolean {
  return Option.match(state.page, {
    onNone: () =>
      Option.match(state.data, {
        onNone: () => false,
        onSome: (thread) => thread.messageWindow?.hasMoreOlder === true,
      }),
    onSome: (page) => page.hasMore,
  });
}
