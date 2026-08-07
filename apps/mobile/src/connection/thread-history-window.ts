/**
 * Mobile thread-history window.
 *
 * Threads load as a window of recent user-anchored turns: `initialTurnLimit`
 * turns on open, `olderTurnLimit` turns per "load earlier" page. Phones pay for
 * hydrated history twice — resident memory and the feed rebuild that runs on
 * every stream tick — so `residentMessageCeiling` additionally holds back the
 * *automatic* refills (underfill recovery, deep-revert refill) once a thread
 * already carries that many messages. It is deliberately soft: it never trims a
 * loaded page and never overrides the server's `page.hasMore`, so an explicit
 * scroll-to-top request still pages past it and no history becomes unreachable.
 *
 * `messageWindowLimit`/`messageOlderPageSize` are the LEGACY message-count
 * window, used only against servers that do not advertise
 * `threadSnapshotPagination`.
 */
export const MOBILE_THREAD_HISTORY_WINDOW = {
  messageWindowLimit: 150,
  messageOlderPageSize: 100,
  initialTurnLimit: 10,
  olderTurnLimit: 20,
  // 150 * MAX_MESSAGE_WINDOW_MULTIPLIER, matching the resident ceiling the
  // legacy message window enforced by trimming.
  residentMessageCeiling: 750,
} as const;
