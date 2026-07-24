import { describe, expect, it } from "vite-plus/test";

import { createDraftSubmissionTracker } from "./draftSubmissionState";

describe("draft submission tracker", () => {
  it("keeps successful submissions materialized until their shell is observed", () => {
    const tracker = createDraftSubmissionTracker();

    tracker.begin("draft-1");
    expect(tracker.hasStarted("draft-1")).toBe(true);
    tracker.finish("draft-1", true);
    expect(tracker.hasStarted("draft-1")).toBe(true);
    tracker.clear("draft-1");
    expect(tracker.hasStarted("draft-1")).toBe(false);
  });

  it("clears failed submissions so their restored composer remains a draft", () => {
    const tracker = createDraftSubmissionTracker();

    tracker.begin("draft-1");
    tracker.finish("draft-1", false);
    expect(tracker.hasStarted("draft-1")).toBe(false);
  });
});
