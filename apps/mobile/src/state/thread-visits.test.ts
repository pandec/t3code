import { describe, expect, it } from "vite-plus/test";

import { markThreadVisited } from "./thread-visits";

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

  it("keeps only the 1,000 newest visit markers", () => {
    const current = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [
        `environment-1:thread-${index}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      ]),
    );

    const next = markThreadVisited(current, "environment-1:latest", "2026-06-01T10:00:00.000Z");

    expect(Object.keys(next)).toHaveLength(1_000);
    expect(next["environment-1:latest"]).toBe("2026-06-01T10:00:00.000Z");
    expect(next["environment-1:thread-0"]).toBeUndefined();
  });
});
