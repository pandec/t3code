/**
 * Mobile message-history window.
 *
 * `messageWindowLimit` is how many of a thread's most recent messages stay hydrated in the
 * client; `messageOlderPageSize` is how many older messages one "load older" request pulls
 * in. Phones pay for hydrated history twice — resident memory and the feed
 * rebuild that runs on every stream tick — so the resident window stays well
 * under a desktop budget, and a page stays small enough to land inside a single
 * scroll gesture.
 */
export const MOBILE_THREAD_HISTORY_WINDOW = {
  messageWindowLimit: 150,
  messageOlderPageSize: 100,
} as const;
