import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isSidebarActiveWorkThread } from "./sidebarActiveWork";

describe("isSidebarActiveWorkThread", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };
  const ready = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };

  it("keeps marked threads even when nothing runs", () => {
    expect(isSidebarActiveWorkThread(ready)).toBe(false);
    expect(
      isSidebarActiveWorkThread({ ...ready, activeMarkedAt: "2026-03-09T10:00:00.000Z" }),
    ).toBe(true);
  });

  it("keeps running threads and threads that need the user", () => {
    expect(isSidebarActiveWorkThread({ ...ready, runtime })).toBe(true);
    expect(isSidebarActiveWorkThread({ ...ready, hasPendingApprovals: true })).toBe(true);
    expect(isSidebarActiveWorkThread({ ...ready, hasPendingUserInput: true })).toBe(true);
  });

  it("drops finished and failed threads", () => {
    expect(
      isSidebarActiveWorkThread({ ...ready, runtime: { ...runtime, status: "completed" } }),
    ).toBe(false);
    expect(isSidebarActiveWorkThread({ ...ready, runtime: { ...runtime, status: "failed" } })).toBe(
      false,
    );
  });
});
