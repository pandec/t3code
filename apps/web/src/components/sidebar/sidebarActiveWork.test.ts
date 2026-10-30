import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isSidebarActiveWorkThread,
  matchesSidebarActiveWorkFilter,
  nextActiveWorkThreadKeys,
} from "./sidebarActiveWork";
import { makeThreadFixture } from "../../test-fixtures";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

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

describe("active work filter session", () => {
  const now = "2026-10-30T12:00:00.000Z";
  const key = (thread: ReturnType<typeof makeThreadFixture>) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const thread = makeThreadFixture({ runtime: null, activeMarkedAt: now });
  const liveEnvironmentIds = new Set([thread.environmentId]);
  const finished = { ...thread, activeMarkedAt: null };
  const other = { ...thread, environmentId: EnvironmentId.make("other") };
  const options = {
    retainedKeys: new Set<string>(),
    includeDone: false,
    routeThreadKey: null,
    now,
  };

  it("retains activity, admits later activity, and resets on disable", () => {
    const first = nextActiveWorkThreadKeys([], true, [thread], now, liveEnvironmentIds);
    expect(first).toEqual([key(thread)]);
    const later = nextActiveWorkThreadKeys(first, true, [finished, other], now, liveEnvironmentIds);
    expect(later).toEqual([key(thread), key(other)]);
    expect(nextActiveWorkThreadKeys(later, true, [finished], now, liveEnvironmentIds)).toBe(later);
    expect(
      matchesSidebarActiveWorkFilter(finished, {
        ...options,
        retainedKeys: new Set(later),
      }),
    ).toBe(true);
    const disabled = nextActiveWorkThreadKeys(
      later,
      false,
      [finished, other],
      now,
      liveEnvironmentIds,
    );
    expect(disabled).toEqual([]);
    expect(
      nextActiveWorkThreadKeys(disabled, true, [finished, other], now, liveEnvironmentIds),
    ).toEqual([key(other)]);
  });

  it("forgets an archived shell removed by a live environment, but retains disconnected keys", () => {
    const retained = [key(thread), key(other)];
    const afterArchive = nextActiveWorkThreadKeys(retained, true, [], now, liveEnvironmentIds);
    expect(afterArchive).toEqual([key(other)]);
    expect(nextActiveWorkThreadKeys(afterArchive, true, [finished], now, liveEnvironmentIds)).toBe(
      afterArchive,
    );
  });

  it.each([
    { archivedAt: now },
    { settledOverride: "settled" as const },
    { snoozedAt: now, snoozedUntil: "2026-10-31T12:00:00.000Z" },
  ])("forgets parked threads even when marked, unless open: %o", (parked) => {
    const retained = [key(thread)];
    const hidden = { ...thread, ...parked };
    expect(nextActiveWorkThreadKeys(retained, true, [hidden], now, liveEnvironmentIds)).toEqual([]);
    const parkedOptions = { ...options, retainedKeys: new Set(retained), includeDone: true };
    expect(matchesSidebarActiveWorkFilter(hidden, parkedOptions)).toBe(false);
    expect(
      matchesSidebarActiveWorkFilter(hidden, { ...parkedOptions, routeThreadKey: key(thread) }),
    ).toBe(true);
    expect(nextActiveWorkThreadKeys([], true, [finished], now, liveEnvironmentIds)).toEqual([]);
  });

  it("includes Done only when enabled and uses the visit watermark", () => {
    const done = makeThreadFixture({
      id: ThreadId.make("done"),
      runtime: null,
      lastVisitedAt: "2026-10-30T10:00:00.000Z",
      latestRun: {
        runId: RunId.make("completed-run"),
        assistantMessageId: null,
        status: "completed",
        requestedAt: "2026-10-30T10:30:00.000Z",
        startedAt: "2026-10-30T10:30:00.000Z",
        completedAt: now,
      },
    });
    expect(matchesSidebarActiveWorkFilter(done, options)).toBe(false);
    expect(matchesSidebarActiveWorkFilter(done, { ...options, includeDone: true })).toBe(true);
    expect(
      matchesSidebarActiveWorkFilter(
        { ...done, lastVisitedAt: now },
        {
          ...options,
          includeDone: true,
        },
      ),
    ).toBe(false);
    const legacyDone = { ...done };
    delete legacyDone.lastVisitedAt;
    expect(
      matchesSidebarActiveWorkFilter(legacyDone, {
        ...options,
        includeDone: true,
        localLastVisitedAt: "2026-10-30T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(nextActiveWorkThreadKeys([], true, [done], now, liveEnvironmentIds)).toEqual([]);
  });
});
