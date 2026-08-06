import { describe, expect, it } from "vite-plus/test";

import { MOBILE_THREAD_HISTORY_WINDOW } from "../../connection/thread-history-window";
import {
  LOAD_OLDER_MESSAGES_THRESHOLD_PX,
  distanceFromFeedTop,
  shouldReleaseOlderMessagesRequest,
  shouldRequestOlderMessages,
  shouldRequestOlderMessagesForUnderfilledFeed,
  shouldRetryUnderfilledOlderMessagesAfterReady,
} from "./threadHistoryLoadMore";

const base = {
  distanceFromTop: 0,
  hasOlderMessages: true,
  loadingOlderMessages: false,
  requestInFlight: false,
};

describe("mobile thread history window", () => {
  it("keeps a phone-sized resident window and a single-gesture page", () => {
    expect(MOBILE_THREAD_HISTORY_WINDOW.messageWindowLimit).toBe(150);
    expect(MOBILE_THREAD_HISTORY_WINDOW.messageOlderPageSize).toBe(100);
    expect(MOBILE_THREAD_HISTORY_WINDOW.messageOlderPageSize).toBeLessThan(
      MOBILE_THREAD_HISTORY_WINDOW.messageWindowLimit,
    );
  });
});

describe("distanceFromFeedTop", () => {
  it("adds the top inset back so automatic insets report zero at the top", () => {
    // Under iOS automatic content insets the list rests at -headerHeight.
    expect(distanceFromFeedTop({ contentOffsetY: -96, topInset: 96 })).toBe(0);
    // Without automatic insets the header spacer is content, so offset is raw.
    expect(distanceFromFeedTop({ contentOffsetY: 240, topInset: 0 })).toBe(240);
  });
});

describe("shouldReleaseOlderMessagesRequest", () => {
  it("releases repeated disconnected attempts and permits the next top-scroll after reconnect", () => {
    const initial = {
      oldestFeedEntryId: "message-3",
      loadingOlderMessages: false,
      settledCount: 0,
    };
    const firstDisconnected = { ...initial, settledCount: 1 };
    const secondDisconnected = { ...initial, settledCount: 2 };

    let requestInFlight = true;
    if (shouldReleaseOlderMessagesRequest(initial, firstDisconnected)) requestInFlight = false;
    expect(shouldRequestOlderMessages({ ...base, requestInFlight })).toBe(true);

    requestInFlight = true;
    if (shouldReleaseOlderMessagesRequest(firstDisconnected, secondDisconnected)) {
      requestInFlight = false;
    }
    expect(shouldRequestOlderMessages({ ...base, requestInFlight })).toBe(true);

    // Warm resume itself leaves the message/window signals unchanged, but the
    // terminal disconnected attempt already released the latch, so its next
    // top-scroll is accepted without waiting for a snapshot or entry change.
    expect(shouldReleaseOlderMessagesRequest(secondDisconnected, secondDisconnected)).toBe(false);
    expect(shouldRequestOlderMessages({ ...base, requestInFlight })).toBe(true);
  });
});

describe("underfilled feed paging", () => {
  const underfilled = {
    contentHeight: 400,
    viewportHeight: 800,
    error: null,
    hasOlderMessages: true,
    loadingOlderMessages: false,
    requestInFlight: false,
  };

  it("retries once when reconnect clears a disconnected error", () => {
    expect(
      shouldRetryUnderfilledOlderMessagesAfterReady(
        "The environment is not connected.",
        underfilled,
      ),
    ).toBe(true);
  });

  it("does not loop after a stale-generation page settles without progress", () => {
    const loading = {
      oldestFeedEntryId: "message-3",
      loadingOlderMessages: true,
      settledCount: 0,
    };
    const staleSettlement = {
      ...loading,
      loadingOlderMessages: false,
      settledCount: 1,
    };
    let requestInFlight = true;
    let requestCount = 1;

    if (shouldReleaseOlderMessagesRequest(loading, staleSettlement)) requestInFlight = false;
    if (
      shouldRetryUnderfilledOlderMessagesAfterReady(null, {
        ...underfilled,
        requestInFlight,
      })
    ) {
      requestCount += 1;
    }
    expect(requestCount).toBe(1);
  });

  it("waits for content remeasurement before requesting after a successful page", () => {
    const loading = {
      oldestFeedEntryId: "message-3",
      loadingOlderMessages: true,
      settledCount: 0,
    };
    const successfulSettlement = {
      oldestFeedEntryId: "message-1",
      loadingOlderMessages: false,
      settledCount: 1,
    };
    let requestInFlight = true;
    let requestCount = 1;

    if (shouldReleaseOlderMessagesRequest(loading, successfulSettlement)) requestInFlight = false;
    if (
      shouldRetryUnderfilledOlderMessagesAfterReady(null, {
        ...underfilled,
        requestInFlight,
      })
    ) {
      requestCount += 1;
    }
    expect(requestCount).toBe(1);

    if (
      shouldRequestOlderMessagesForUnderfilledFeed({
        ...underfilled,
        contentHeight: 600,
        requestInFlight,
      })
    ) {
      requestCount += 1;
    }
    expect(requestCount).toBe(2);
  });
});

describe("shouldRequestOlderMessages", () => {
  it("requests once the viewport is within the threshold of the top", () => {
    expect(
      shouldRequestOlderMessages({
        ...base,
        distanceFromTop: LOAD_OLDER_MESSAGES_THRESHOLD_PX,
      }),
    ).toBe(true);
    expect(
      shouldRequestOlderMessages({
        ...base,
        distanceFromTop: LOAD_OLDER_MESSAGES_THRESHOLD_PX + 1,
      }),
    ).toBe(false);
  });

  it("still requests when the user overscrolls past the top", () => {
    expect(shouldRequestOlderMessages({ ...base, distanceFromTop: -120 })).toBe(true);
  });

  it("does not request when the window is already complete", () => {
    expect(shouldRequestOlderMessages({ ...base, hasOlderMessages: false })).toBe(false);
  });

  it("does not stack requests while a page is loading or latched", () => {
    expect(shouldRequestOlderMessages({ ...base, loadingOlderMessages: true })).toBe(false);
    expect(shouldRequestOlderMessages({ ...base, requestInFlight: true })).toBe(false);
  });

  it("honours an explicit threshold", () => {
    expect(shouldRequestOlderMessages({ ...base, distanceFromTop: 120, thresholdPx: 100 })).toBe(
      false,
    );
    expect(shouldRequestOlderMessages({ ...base, distanceFromTop: 80, thresholdPx: 100 })).toBe(
      true,
    );
  });
});
