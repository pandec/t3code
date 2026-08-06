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
  /** Monotonic signal that advances whenever an older-page attempt settles. */
  readonly settledCount: number;
  /** The most recent older-page failure. */
  readonly error?: string | null;
  /** Requests the next older page. Safe to call when nothing is pending. */
  readonly onLoadOlderMessages: () => void;
}

export interface ThreadHistoryRequestSignals {
  readonly oldestFeedEntryId: string | null;
  readonly loadingOlderMessages: boolean;
  readonly settledCount: number;
}

/** True when a feed request latch must be released for a new top-scroll attempt. */
export function shouldReleaseOlderMessagesRequest(
  previous: ThreadHistoryRequestSignals,
  current: ThreadHistoryRequestSignals,
): boolean {
  return (
    previous.oldestFeedEntryId !== current.oldestFeedEntryId ||
    previous.loadingOlderMessages !== current.loadingOlderMessages ||
    previous.settledCount !== current.settledCount
  );
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

/** Geometry and request state used by automatic underfilled-feed paging. */
export interface ThreadUnderfilledHistoryRequestState {
  readonly contentHeight: number;
  readonly viewportHeight: number;
  readonly error: string | null | undefined;
  readonly hasOlderMessages: boolean;
  readonly loadingOlderMessages: boolean;
  readonly requestInFlight: boolean;
}

/** True when a ready, underfilled feed should automatically request another page. */
export function shouldRequestOlderMessagesForUnderfilledFeed(
  input: ThreadUnderfilledHistoryRequestState,
): boolean {
  return (
    input.error == null &&
    input.viewportHeight > 0 &&
    input.contentHeight <= input.viewportHeight &&
    shouldRequestOlderMessages({ ...input, distanceFromTop: 0 })
  );
}

/** Auto-retries an underfilled feed only when a previous paging error clears. */
export function shouldRetryUnderfilledOlderMessagesAfterReady(
  previousError: string | null | undefined,
  current: ThreadUnderfilledHistoryRequestState,
): boolean {
  return (
    previousError != null &&
    current.error == null &&
    shouldRequestOlderMessagesForUnderfilledFeed(current)
  );
}

export interface ThreadUnderfilledHistoryEffectSignals {
  readonly threadId: string;
  readonly error: string | null | undefined;
  readonly viewportHeight: number;
}

export interface ThreadUnderfilledHistoryEffectState
  extends ThreadUnderfilledHistoryEffectSignals, ThreadUnderfilledHistoryRequestState {}

export type ThreadUnderfilledHistoryEffectAction =
  | "none"
  | "request-older-messages"
  | "reset-content-height";

/** Decides the bounded action for ThreadFeed's underfilled-history effect. */
export function decideThreadUnderfilledHistoryEffectAction(
  previous: ThreadUnderfilledHistoryEffectSignals,
  current: ThreadUnderfilledHistoryEffectState,
): ThreadUnderfilledHistoryEffectAction {
  if (previous.threadId !== current.threadId) return "reset-content-height";

  const viewportBecameMeasurable = previous.viewportHeight === 0 && current.viewportHeight > 0;
  const pagingErrorCleared = previous.error != null && current.error == null;
  return (viewportBecameMeasurable || pagingErrorCleared) &&
    shouldRequestOlderMessagesForUnderfilledFeed(current)
    ? "request-older-messages"
    : "none";
}
