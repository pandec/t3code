import { describe, expect, it } from "vite-plus/test";

import { MOBILE_THREAD_HISTORY_WINDOW } from "../../connection/thread-history-window";
import {
  LOAD_OLDER_MESSAGES_THRESHOLD_PX,
  distanceFromFeedTop,
  shouldRequestOlderMessages,
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
