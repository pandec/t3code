import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  sortOlderThreadsForSidebar,
  threadIsOlder,
  threadOlderRecencyAtMs,
  type ThreadOlderSource,
} from "./threadOlder.ts";

const NOW = "2026-04-10T00:00:00.000Z";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

function thread(overrides: Partial<ThreadOlderSource> = {}): ThreadOlderSource {
  return {
    createdAt: CREATED_AT,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestUserMessageAt: null,
    latestTurn: null,
    movedToTopAt: null,
    session: null,
    ...overrides,
  } as ThreadOlderSource;
}

function turn(overrides: { readonly completedAt: string }): ThreadOlderSource["latestTurn"] {
  return {
    turnId: TurnId.make("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-02-01T00:00:00.000Z",
    startedAt: "2026-02-01T00:00:05.000Z",
    assistantMessageId: null,
    ...overrides,
  };
}

function session(
  status: "starting" | "running" | "error",
): NonNullable<ThreadOlderSource["session"]> {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("threadOlderRecencyAtMs", () => {
  it("takes the newest of creation, activity, and a manual move to top", () => {
    expect(
      threadOlderRecencyAtMs(
        thread({
          latestUserMessageAt: "2026-04-02T00:00:00.000Z",
          movedToTopAt: "2026-04-09T00:00:00.000Z",
        }),
      ),
    ).toBe(Date.parse("2026-04-09T00:00:00.000Z"));
  });

  it("uses a turn completion the user never followed up on", () => {
    expect(
      threadOlderRecencyAtMs(
        thread({ latestTurn: turn({ completedAt: "2026-04-08T00:00:00.000Z" }) }),
      ),
    ).toBe(Date.parse("2026-04-08T00:00:00.000Z"));
  });

  it("falls back to creation time for an untouched thread", () => {
    expect(threadOlderRecencyAtMs(thread())).toBe(Date.parse(CREATED_AT));
  });
});

describe("threadIsOlder", () => {
  it("files a thread away only once it is past the window", () => {
    const quiet = thread({ latestUserMessageAt: "2026-04-01T00:00:00.000Z" });
    expect(threadIsOlder(quiet, { now: NOW, afterDays: 7 })).toBe(true);
    expect(threadIsOlder(quiet, { now: NOW, afterDays: 10 })).toBe(false);
  });

  it("keeps a thread exactly at the window boundary in the inbox", () => {
    expect(
      threadIsOlder(thread({ latestUserMessageAt: "2026-04-03T00:00:00.000Z" }), {
        now: NOW,
        afterDays: 7,
      }),
    ).toBe(false);
    expect(
      threadIsOlder(thread({ latestUserMessageAt: "2026-04-02T23:59:59.999Z" }), {
        now: NOW,
        afterDays: 7,
      }),
    ).toBe(true);
  });

  it("ages an untouched thread by its creation time", () => {
    expect(threadIsOlder(thread(), { now: NOW, afterDays: 7 })).toBe(true);
    expect(
      threadIsOlder(thread({ createdAt: "2026-04-09T00:00:00.000Z" }), { now: NOW, afterDays: 7 }),
    ).toBe(false);
  });

  it("lifts a thread back out as soon as it is moved to top", () => {
    expect(
      threadIsOlder(
        thread({
          latestUserMessageAt: "2026-04-01T00:00:00.000Z",
          movedToTopAt: "2026-04-09T00:00:00.000Z",
        }),
        { now: NOW, afterDays: 7 },
      ),
    ).toBe(false);
  });

  it("leaves blocked and live work in the inbox however long it has sat there", () => {
    const quiet = thread({ latestUserMessageAt: "2026-01-01T00:00:00.000Z" });
    expect(threadIsOlder(quiet, { now: NOW, afterDays: 7 })).toBe(true);
    for (const blocked of [
      { ...quiet, hasPendingApprovals: true },
      { ...quiet, hasPendingUserInput: true },
      { ...quiet, session: session("starting") },
      { ...quiet, session: session("running") },
    ]) {
      expect(threadIsOlder(blocked, { now: NOW, afterDays: 7 })).toBe(false);
    }
    // A dead or errored session is not work in flight.
    expect(threadIsOlder({ ...quiet, session: session("error") }, { now: NOW, afterDays: 7 })).toBe(
      true,
    );
  });

  it("never files away on unusable input", () => {
    const quiet = thread({ latestUserMessageAt: "2026-01-01T00:00:00.000Z" });
    expect(threadIsOlder(quiet, { now: "not a date", afterDays: 7 })).toBe(false);
    expect(threadIsOlder(quiet, { now: NOW, afterDays: Number.NaN })).toBe(false);
    expect(threadIsOlder(quiet, { now: NOW, afterDays: 0 })).toBe(false);
    expect(
      threadIsOlder(
        { ...quiet, createdAt: "nonsense", latestUserMessageAt: null },
        { now: NOW, afterDays: 7 },
      ),
    ).toBe(false);
  });
});

describe("sortOlderThreadsForSidebar", () => {
  it("orders by newest activity, breaking ties on id", () => {
    const older = { ...thread({ latestUserMessageAt: "2026-03-01T00:00:00.000Z" }), id: "a" };
    const newer = { ...thread({ latestUserMessageAt: "2026-03-20T00:00:00.000Z" }), id: "b" };
    const tie = { ...thread({ latestUserMessageAt: "2026-03-20T00:00:00.000Z" }), id: "a0" };
    expect(sortOlderThreadsForSidebar([older, newer, tie]).map((entry) => entry.id)).toEqual([
      "a0",
      "b",
      "a",
    ]);
  });
});
