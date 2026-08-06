/**
 * Scroll-driven paging of older thread messages.
 *
 * Kept free of React and react-native so the trigger rule is unit-testable; the
 * feed only supplies scroll geometry and the current window state.
 */

/** Distance from the top of the feed, in px, at which the next older page is requested. */
export const LOAD_OLDER_MESSAGES_THRESHOLD_PX = 400;

/** Everything the feed needs to page older messages in as the user scrolls up. */
export interface ThreadHistoryWindowState {
  /** More messages exist before the oldest loaded one. */
  readonly hasOlderMessages: boolean;
  /** A page request is in flight. */
  readonly loadingOlderMessages: boolean;
  /** Requests the next older page. Safe to call when nothing is pending. */
  readonly onLoadOlderMessages: () => void;
}

/**
 * Distance from the very top of the scrollable content.
 *
 * `topInset` is added back because under iOS automatic content insets the
 * resting offset at the top of the list is `-headerHeight`, not 0 — the same
 * correction the header-material threshold makes.
 */
export function distanceFromFeedTop(input: {
  readonly contentOffsetY: number;
  readonly topInset: number;
}): number {
  return input.contentOffsetY + input.topInset;
}

/**
 * True when a scroll position warrants requesting the next older page.
 *
 * `requestInFlight` is the feed's own latch: `loadingOlderMessages` only turns
 * true once the request has been accepted, so without it a burst of scroll
 * events would fire several requests for the same page.
 */
export function shouldRequestOlderMessages(input: {
  readonly distanceFromTop: number;
  readonly hasOlderMessages: boolean;
  readonly loadingOlderMessages: boolean;
  readonly requestInFlight: boolean;
  readonly thresholdPx?: number;
}): boolean {
  if (!input.hasOlderMessages || input.loadingOlderMessages || input.requestInFlight) {
    return false;
  }
  return input.distanceFromTop <= (input.thresholdPx ?? LOAD_OLDER_MESSAGES_THRESHOLD_PX);
}
