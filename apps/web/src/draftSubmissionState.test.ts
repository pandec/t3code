import { describe, expect, it } from "vite-plus/test";

import { createDraftSubmissionTracker } from "./draftSubmissionState";

describe("draft submission tracker", () => {
  it("tracks draft submission lifetime independently by draft id", () => {
    const tracker = createDraftSubmissionTracker();

    tracker.begin("draft-1");
    expect(tracker.isInFlight("draft-1")).toBe(true);
    expect(tracker.isInFlight("draft-2")).toBe(false);

    tracker.end("draft-1");
    expect(tracker.isInFlight("draft-1")).toBe(false);
  });
});
