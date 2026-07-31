import { describe, expect, it } from "vite-plus/test";

import { createThreadVisitRegistry } from "./thread-visits";

describe("thread visit registry", () => {
  it("keeps the newest valid visit for each thread", () => {
    const registry = createThreadVisitRegistry();
    registry.recordVisit("environment-1:thread-1", "2026-06-01T10:00:00.000Z");
    registry.recordVisit("environment-1:thread-1", "invalid");
    registry.recordVisit("environment-1:thread-1", "2026-06-01T09:00:00.000Z");
    registry.recordVisit("environment-1:thread-1", "2026-06-01T11:00:00.000Z");

    expect(registry.lastVisitedAtByThreadKey().get("environment-1:thread-1")).toBe(
      "2026-06-01T11:00:00.000Z",
    );
  });
});
