import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadFeedInsetBaseline,
  resolveThreadFeedInsetReport,
  shouldReleaseThreadFeedAnchor,
  type ThreadFeedInsetReport,
} from "./threadFeedInsets";

describe("thread feed anchor", () => {
  it("releases only an authoritative consumed active anchor", () => {
    expect(
      shouldReleaseThreadFeedAnchor({
        anchorMessageId: "message-1",
        readyAnchorKey: "message-1",
        readySize: 0,
      }),
    ).toBe(true);
    expect(
      shouldReleaseThreadFeedAnchor({
        anchorMessageId: "message-1",
        readyAnchorKey: "message-1",
        readySize: 1,
      }),
    ).toBe(false);
    expect(
      shouldReleaseThreadFeedAnchor({
        anchorMessageId: "message-1",
        readyAnchorKey: "message-2",
        readySize: 0,
      }),
    ).toBe(false);
    expect(
      shouldReleaseThreadFeedAnchor({
        anchorMessageId: null,
        readyAnchorKey: "message-1",
        readySize: 0,
      }),
    ).toBe(false);
    expect(
      shouldReleaseThreadFeedAnchor({
        anchorMessageId: "message-1",
        readyAnchorKey: "message-1",
        readySize: Number.NaN,
      }),
    ).toBe(false);
  });
});

describe("thread feed insets", () => {
  it("prefers the measured overlay height and removes native inset overcount", () => {
    expect(
      resolveThreadFeedInsetBaseline({
        measuredOverlayHeight: 148,
        estimatedOverlayHeight: 96,
        nativeInsetOvercount: 34,
      }),
    ).toBe(114);
  });

  it("falls back to the estimate and clamps the baseline to zero", () => {
    expect(
      resolveThreadFeedInsetBaseline({
        measuredOverlayHeight: null,
        estimatedOverlayHeight: 96,
        nativeInsetOvercount: 34,
      }),
    ).toBe(62);
    expect(
      resolveThreadFeedInsetBaseline({
        measuredOverlayHeight: 20,
        estimatedOverlayHeight: 96,
        nativeInsetOvercount: 34,
      }),
    ).toBe(0);
  });

  it("ignores non-finite measurements and estimates", () => {
    expect(
      resolveThreadFeedInsetBaseline({
        measuredOverlayHeight: Number.NaN,
        estimatedOverlayHeight: 96,
        nativeInsetOvercount: 34,
      }),
    ).toBe(62);
    expect(
      resolveThreadFeedInsetBaseline({
        measuredOverlayHeight: null,
        estimatedOverlayHeight: Number.POSITIVE_INFINITY,
        nativeInsetOvercount: Number.NaN,
      }),
    ).toBe(0);
  });

  it("suppresses synchronous reports while the keyboard is visible", () => {
    expect(
      resolveThreadFeedInsetReport({
        listMountKey: "thread:filled",
        baseline: 114,
        keyboardVisible: true,
        anchoredEndSpaceActive: false,
        lastReported: null,
      }),
    ).toBeNull();
  });

  it("deduplicates by list mount and baseline", () => {
    const lastReported: ThreadFeedInsetReport = {
      listMountKey: "thread:filled",
      baseline: 114,
    };

    expect(
      resolveThreadFeedInsetReport({
        ...lastReported,
        keyboardVisible: false,
        anchoredEndSpaceActive: false,
        lastReported,
      }),
    ).toBeNull();
    expect(
      resolveThreadFeedInsetReport({
        listMountKey: "thread:filled",
        baseline: 140,
        keyboardVisible: false,
        anchoredEndSpaceActive: false,
        lastReported,
      }),
    ).toEqual({ listMountKey: "thread:filled", baseline: 140 });
    expect(
      resolveThreadFeedInsetReport({
        listMountKey: "thread:empty",
        baseline: 114,
        keyboardVisible: false,
        anchoredEndSpaceActive: false,
        lastReported,
      }),
    ).toEqual({ listMountKey: "thread:empty", baseline: 114 });
  });

  it("leaves the anchored end space alone on composer height changes", () => {
    const lastReported: ThreadFeedInsetReport = {
      listMountKey: "thread:filled",
      baseline: 114,
    };

    expect(
      resolveThreadFeedInsetReport({
        listMountKey: "thread:filled",
        baseline: 220,
        keyboardVisible: false,
        anchoredEndSpaceActive: true,
        lastReported,
      }),
    ).toBeNull();
    // A fresh list mount still primes: its override starts empty and the
    // integration's blank space is remounted with it.
    expect(
      resolveThreadFeedInsetReport({
        listMountKey: "thread:empty",
        baseline: 220,
        keyboardVisible: false,
        anchoredEndSpaceActive: true,
        lastReported,
      }),
    ).toEqual({ listMountKey: "thread:empty", baseline: 220 });
    // Once the anchor clears, the pending composer height lands.
    expect(
      resolveThreadFeedInsetReport({
        listMountKey: "thread:filled",
        baseline: 220,
        keyboardVisible: false,
        anchoredEndSpaceActive: false,
        lastReported,
      }),
    ).toEqual({ listMountKey: "thread:filled", baseline: 220 });
  });
});
