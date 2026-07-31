import { describe, expect, it } from "vite-plus/test";

import { markThreadVisited, mergeThreadVisits } from "./thread-visits";

describe("thread visit registry", () => {
  it("keeps the newest valid visit for each thread", () => {
    const first = markThreadVisited({}, "environment-1:thread-1", "2026-06-01T10:00:00.000Z");
    expect(markThreadVisited(first, "environment-1:thread-1", "invalid")).toBe(first);
    expect(markThreadVisited(first, "environment-1:thread-1", "2026-06-01T09:00:00.000Z")).toBe(
      first,
    );
    const latest = markThreadVisited(first, "environment-1:thread-1", "2026-06-01T11:00:00.000Z");

    expect(latest["environment-1:thread-1"]).toBe("2026-06-01T11:00:00.000Z");
  });

  it("merges visits recorded before persisted preferences finish loading", () => {
    expect(
      mergeThreadVisits(
        {
          "environment-1:persisted": "2026-06-01T09:00:00.000Z",
          "environment-1:shared": "2026-06-01T10:00:00.000Z",
        },
        {
          "environment-1:current": "2026-06-01T11:00:00.000Z",
          "environment-1:shared": "2026-06-01T09:30:00.000Z",
        },
      ),
    ).toEqual({
      "environment-1:persisted": "2026-06-01T09:00:00.000Z",
      "environment-1:shared": "2026-06-01T10:00:00.000Z",
      "environment-1:current": "2026-06-01T11:00:00.000Z",
    });
  });
});
