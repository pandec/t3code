import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { THREAD_STATUS_PARITY_CASES } from "@t3tools/client-runtime/testing/thread-status-parity";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  resolveThreadListV2MenuActionIds,
  resolveThreadListV2Enabled,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2Status,
  resolveThreadListV2SwipeActions,
  sortThreadsForListV2,
} from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

const NOW = "2026-06-02T00:00:00.000Z";

describe("resolveThreadListV2MenuActionIds", () => {
  it("keeps archive available across active, settled, and legacy rows", () => {
    expect(
      resolveThreadListV2MenuActionIds({ settlementSupported: true, variant: "card" }),
    ).toEqual(["settle", "archive", "delete"]);
    expect(
      resolveThreadListV2MenuActionIds({ settlementSupported: true, variant: "slim" }),
    ).toEqual(["unsettle", "archive", "delete"]);
    expect(
      resolveThreadListV2MenuActionIds({ settlementSupported: false, variant: "card" }),
    ).toEqual(["archive", "delete"]);
  });
});

describe("resolveThreadListV2SnoozeMenuSelection", () => {
  it("accepts a displayed evening preset while its wake time is still future", () => {
    const menuOpenedAt = new Date(2026, 4, 8, 16, 59, 30);
    const selectedAt = new Date(2026, 4, 8, 17, 0, 30);
    const displayedPresets = resolveSnoozePresets(menuOpenedAt);

    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: "snooze:evening",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection).toEqual({
      _tag: "selected",
      preset: displayedPresets.find((preset) => preset.id === "evening"),
    });
  });

  it("expires a displayed preset once its wake time has passed", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 16, 59, 30));

    expect(
      resolveThreadListV2SnoozeMenuSelection({
        event: "snooze:evening",
        displayedPresets,
        now: new Date(2026, 4, 8, 18, 0, 1),
      }),
    ).toEqual({ _tag: "expired" });
  });

  it("recomputes presets that remain available instead of using old timestamps", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 10));
    const selectedAt = new Date(2026, 4, 8, 10, 30);
    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: "snooze:hour",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection._tag).toBe("selected");
    if (selection._tag === "selected") {
      expect(selection.preset.snoozedUntil).toBe(
        new Date(selectedAt.getTime() + 60 * 60 * 1_000).toISOString(),
      );
    }
  });
});

describe("resolveThreadListV2Enabled", () => {
  it("defaults on when the device has never chosen", () => {
    expect(
      resolveThreadListV2Enabled({ legacyPreference: undefined, preferencesLoaded: true }),
    ).toBe(true);
  });

  it("honors an explicit legacy opt-in", () => {
    expect(resolveThreadListV2Enabled({ legacyPreference: true, preferencesLoaded: true })).toBe(
      false,
    );
    expect(resolveThreadListV2Enabled({ legacyPreference: false, preferencesLoaded: true })).toBe(
      true,
    );
  });

  it("holds the default while preferences are still loading so the list does not remount", () => {
    expect(
      resolveThreadListV2Enabled({ legacyPreference: undefined, preferencesLoaded: false }),
    ).toBe(true);
  });
});

describe("resolveThreadListV2Status", () => {
  it.each(THREAD_STATUS_PARITY_CASES)(
    "matches the canonical ladder: $name",
    ({ thread, expected }) => {
      expect(resolveThreadListV2Status(thread)).toBe(expected);
    },
  );
});

describe("resolveThreadListV2SwipeActions", () => {
  it("offers settle and snooze for an active snoozable thread", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "settle", secondary: "snooze", left: "archive" });
  });

  it("offers un-settle and snooze for settled history", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "unsettle", secondary: "snooze", left: "archive" });
  });

  it("omits snooze when the server or thread does not allow it", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "settle", secondary: null, left: "archive" });
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: false,
      }),
    ).toEqual({ primary: "settle", secondary: null, left: "archive" });
  });

  it("falls back to archive only for a pre-lifecycle server", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: false,
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "archive", secondary: null, left: null });
  });

  it("offers wake and no snooze on a snoozed row", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
        snoozed: true,
      }),
    ).toEqual({ primary: "unsnooze", secondary: null, left: "archive" });
  });
});

describe("resolveThreadListV2SnoozeGateExpiryMs", () => {
  it("reports when an unadopted turn's grace window lapses", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      latestUserMessageAt: "2026-06-02T00:00:30.000Z",
    });
    expect(resolveThreadListV2SnoozeGateExpiryMs(thread, { now: "2026-06-02T00:01:00.000Z" })).toBe(
      Date.parse("2026-06-02T00:02:30.000Z"),
    );
  });

  it("returns null once the thread is snoozable or when only data can unblock it", () => {
    expect(
      resolveThreadListV2SnoozeGateExpiryMs(
        makeThread({ id: ThreadId.make("ready"), title: "Ready" }),
        { now: NOW },
      ),
    ).toBe(null);
    expect(
      resolveThreadListV2SnoozeGateExpiryMs(
        makeThread({
          id: ThreadId.make("blocked"),
          title: "Blocked",
          hasPendingApprovals: true,
          latestUserMessageAt: NOW,
        }),
        { now: NOW },
      ),
    ).toBe(null);
  });
});

describe("sortThreadsForListV2", () => {
  it("orders by creation time, newest first, ignoring activity", () => {
    const sorted = sortThreadsForListV2([
      { id: "oldest", createdAt: "2026-06-01T08:00:00.000Z" },
      { id: "newest", createdAt: "2026-06-01T12:00:00.000Z" },
      { id: "middle", createdAt: "2026-06-01T10:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("ignores the latest user message unless the preference is on", () => {
    const threads = [
      { id: "older", createdAt: "2026-06-01T08:00:00.000Z", latestUserMessageAt: NOW },
      { id: "newer", createdAt: "2026-06-01T12:00:00.000Z", latestUserMessageAt: null },
    ];
    expect(sortThreadsForListV2(threads).map((thread) => thread.id)).toEqual(["newer", "older"]);
    expect(
      sortThreadsForListV2(threads, { sortByLatestUserMessage: false }).map((thread) => thread.id),
    ).toEqual(["newer", "older"]);
  });

  it("orders by the latest user message when the preference is on", () => {
    const sorted = sortThreadsForListV2(
      [
        {
          id: "created-newest",
          createdAt: "2026-06-01T12:00:00.000Z",
          latestUserMessageAt: "2026-06-01T12:30:00.000Z",
        },
        {
          id: "messaged-newest",
          createdAt: "2026-06-01T08:00:00.000Z",
          latestUserMessageAt: "2026-06-01T14:00:00.000Z",
        },
      ],
      { sortByLatestUserMessage: true },
    );
    expect(sorted.map((thread) => thread.id)).toEqual(["messaged-newest", "created-newest"]);
  });

  // Web uses a fallback chain, not a max, so a thread that has never been
  // messaged sorts by creation rather than sinking to the epoch.
  it("falls back to creation time for threads with no user message", () => {
    const sorted = sortThreadsForListV2(
      [
        {
          id: "messaged",
          createdAt: "2026-06-01T08:00:00.000Z",
          latestUserMessageAt: "2026-06-01T10:00:00.000Z",
        },
        { id: "never-messaged", createdAt: "2026-06-01T12:00:00.000Z", latestUserMessageAt: null },
      ],
      { sortByLatestUserMessage: true },
    );
    expect(sorted.map((thread) => thread.id)).toEqual(["never-messaged", "messaged"]);
  });

  it("keeps an explicit move-to-top above a newer user message", () => {
    const sorted = sortThreadsForListV2(
      [
        {
          id: "messaged",
          createdAt: "2026-06-01T08:00:00.000Z",
          latestUserMessageAt: "2026-06-01T14:00:00.000Z",
        },
        {
          id: "bumped",
          createdAt: "2026-06-01T07:00:00.000Z",
          latestUserMessageAt: "2026-06-01T09:00:00.000Z",
          movedToTopAt: "2026-06-01T15:00:00.000Z",
        },
      ],
      { sortByLatestUserMessage: true },
    );
    expect(sorted.map((thread) => thread.id)).toEqual(["bumped", "messaged"]);
  });
});

describe("buildThreadListV2Items", () => {
  it("composes sticky attention membership with the existing list filters", () => {
    const included = makeThread({ id: ThreadId.make("included"), title: "Fix login" });
    const wrongTitle = makeThread({ id: ThreadId.make("wrong-title"), title: "Greeting" });
    const notMember = makeThread({ id: ThreadId.make("not-member"), title: "Fix logout" });

    const layout = buildThreadListV2Items({
      threads: [included, wrongTitle, notMember],
      attentionMemberThreadKeys: new Set([
        `${environmentId}:${included.id}`,
        `${environmentId}:${wrongTitle.id}`,
      ]),
      environmentId: null,
      searchQuery: "login",
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["included"]);
  });

  it("optionally keeps pinned non-members in the attention-filtered list", () => {
    const pinned = makeThread({
      id: ThreadId.make("pinned"),
      title: "Pinned",
      pinnedAt: NOW,
    });
    const regular = makeThread({ id: ThreadId.make("regular"), title: "Regular" });

    const hidden = buildThreadListV2Items({
      threads: [pinned, regular],
      attentionMemberThreadKeys: new Set(),
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    expect(hidden.items).toEqual([]);

    const visible = buildThreadListV2Items({
      threads: [pinned, regular],
      attentionMemberThreadKeys: new Set(),
      alwaysShowPinnedInAttention: true,
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    expect(visible.items.map((item) => item.thread.id)).toEqual(["pinned"]);
  });

  it("moves a bumped active thread first without changing shelf placement", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("newer"),
          title: "Newer",
          createdAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("bumped"),
          title: "Bumped",
          createdAt: "2026-06-01T08:00:00.000Z",
          movedToTopAt: "2026-06-01T13:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
          movedToTopAt: "2099-01-01T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
          movedToTopAt: "2099-01-01T00:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "bumped",
      "newer",
      "snoozed",
      "settled",
    ]);
  });

  it("hides snoozed threads and counts them — visibility parity with web", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("woken"),
          title: "Woken",
          // Wake time already passed: back in the active list.
          snoozedUntil: "2026-06-01T18:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    // Same createdAt → static sort tiebreaks by id; the point is the woken
    // thread is BACK in the card block and the snoozed one is gone.
    expect(layout.items.map((item) => item.thread.id)).toEqual(["active", "woken"]);
    expect(layout.snoozedCount).toBe(1);
  });

  it("renders pinned threads first and exempts them from auto-settle — parity with web", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("pinned-settled"),
          title: "Pinned while settled",
          pinnedAt: "2026-06-01T12:00:00.000Z",
          // Stale settled state (the decider clears it on pin): the pin wins.
          settledOverride: "settled",
          settledAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["pinned-settled", "active"]);
    expect(layout.items.map((item) => item.pinned)).toEqual([true, false]);
    expect(layout.settledCount).toBe(0);
  });

  it("sorts only the active block by latest user message when enabled", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("active-created-newest"),
        title: "Active created newest",
        createdAt: "2026-06-01T12:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("active-messaged-newest"),
        title: "Active messaged newest",
        createdAt: "2026-06-01T08:00:00.000Z",
        latestUserMessageAt: "2026-06-01T14:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("pinned-messaged-oldest"),
        title: "Pinned messaged oldest",
        createdAt: "2026-06-01T09:00:00.000Z",
        latestUserMessageAt: "2026-06-01T09:30:00.000Z",
        pinnedAt: "2026-06-01T10:00:00.000Z",
      }),
    ];

    const off = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    expect(off.items.map((item) => item.thread.id)).toEqual([
      "pinned-messaged-oldest",
      "active-created-newest",
      "active-messaged-newest",
    ]);

    const on = buildThreadListV2Items({
      threads,
      sortActiveByLatestUserMessage: true,
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    // The pin still leads: only the active block re-orders.
    expect(on.items.map((item) => item.thread.id)).toEqual([
      "pinned-messaged-oldest",
      "active-messaged-newest",
      "active-created-newest",
    ]);
  });

  it("orders pinned threads by creation time and ignores movedToTopAt", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("newer-pinned"),
          title: "Newer pinned",
          createdAt: "2026-06-01T12:00:00.000Z",
          pinnedAt: "2026-06-01T13:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("older-bumped-pinned"),
          title: "Older bumped pinned",
          createdAt: "2026-06-01T08:00:00.000Z",
          movedToTopAt: "2026-06-01T14:00:00.000Z",
          pinnedAt: "2026-06-01T15:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "newer-pinned",
      "older-bumped-pinned",
    ]);
  });

  it("snooze hides a pinned thread and wake restores it to the pinned block", () => {
    const snoozedInput = {
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("pinned-snoozed"),
          title: "Pinned and snoozed",
          pinnedAt: "2026-06-01T12:00:00.000Z",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T11:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
    };

    // Before the wake time: the snooze wins; the pin holds underneath.
    const whileSnoozed = buildThreadListV2Items({ ...snoozedInput, now: NOW });
    expect(whileSnoozed.items.map((item) => item.thread.id)).toEqual(["active"]);
    expect(whileSnoozed.snoozedCount).toBe(1);

    // After the wake time: the thread returns pinned, back on top.
    const afterWake = buildThreadListV2Items({ ...snoozedInput, now: "2026-06-03T10:00:00.000Z" });
    expect(afterWake.items.map((item) => item.thread.id)).toEqual(["pinned-snoozed", "active"]);
    expect(afterWake.items[0]?.pinned).toBe(true);
    expect(afterWake.snoozedCount).toBe(0);
  });

  it("classifies snooze with the second-precise clock and reports the next wake", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("just-woke"),
          title: "Just woke",
          // Woke 30s ago: hidden under the minute-floored clock, visible
          // under the precise one.
          snoozedUntil: "2026-06-02T00:00:30.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("still-snoozed"),
          title: "Still snoozed",
          snoozedUntil: "2026-06-02T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      // Minute-floored partition clock vs precise snooze clock.
      now: "2026-06-02T00:01:00.000Z",
      snoozeNow: "2026-06-02T00:01:07.500Z",
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["just-woke"]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.nextSnoozeWakeAt).toBe("2026-06-02T09:00:00.000Z");
  });

  it("builds snoozed rows between active and settled when the shelf is expanded", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("later"),
          title: "Wakes later",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("sooner"),
          title: "Wakes sooner",
          snoozedUntil: "2026-06-02T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "active",
      "sooner",
      "later",
      "settled",
    ]);
    expect(layout.items.map((item) => item.snoozed)).toEqual([false, true, true, false]);
    expect(layout.snoozedShelfHeaderIndex).toBe(1);
    expect(layout.snoozedCount).toBe(2);
  });

  it("collapses to a header-only shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items).toEqual([]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.snoozedShelfHeaderIndex).toBe(0);
  });

  it("keeps the selected thread on a collapsed shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("open"),
          title: "Open",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("other"),
          title: "Other",
          snoozedUntil: "2026-06-03T10:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      selectedThreadKey: `${environmentId}:open`,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["open"]);
    expect(layout.items[0]?.snoozed).toBe(true);
    expect(layout.snoozedCount).toBe(2);
  });

  it("keeps snoozed threads visible on environments without the snooze capability", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      snoozeEnvironmentIds: new Set(),
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["snoozed"]);
    expect(layout.snoozedCount).toBe(0);
  });

  it("keeps only threads on the pinned model", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("opus"),
          title: "Opus",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-opus-4-5",
          },
        }),
        makeThread({ id: ThreadId.make("codex"), title: "Codex" }),
      ],
      environmentId: null,
      model: "claude-opus-4-5",
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["opus"]);
  });

  it("partitions settled threads into a slim shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("settled-2"),
          title: "Settled 2",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.variant])).toEqual([
      ["active", "card"],
      ["settled", "slim"],
      ["settled-2", "slim"],
    ]);
    expect(layout.items.map((item) => item.isLast)).toEqual([false, false, true]);
    expect(layout.settledCount).toBe(2);
    expect(layout.settledShelfHeaderIndex).toBe(1);
  });

  it("collapses settled threads to a counted shelf header", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      settledShelfExpanded: false,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["active"]);
    expect(layout.settledCount).toBe(1);
    expect(layout.settledShelfHeaderIndex).toBe(1);
  });

  it("keeps the selected settled thread visible when its shelf is collapsed", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("selected"),
          title: "Selected",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("other"),
          title: "Other",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      settledShelfExpanded: false,
      selectedThreadKey: `${environmentId}:selected`,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["selected"]);
    expect(layout.settledCount).toBe(2);
    expect(layout.settledShelfHeaderIndex).toBe(0);
  });

  it("keeps cards in creation order while settled sorts by recency", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("older-created"),
          title: "Older",
          createdAt: "2026-06-01T08:00:00.000Z",
          updatedAt: NOW, // recent activity must NOT promote it
        }),
        makeThread({
          id: ThreadId.make("newer-created"),
          title: "Newer",
          createdAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["newer-created", "older-created"]);
  });

  it("keeps settled threads in the tail and filters by search query", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("match"), title: "Fix login bug" }),
        makeThread({ id: ThreadId.make("miss"), title: "Greeting" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Fix login again",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "login",
      now: NOW,
    });

    expect(items.map((item) => [item.thread.id, item.variant])).toEqual([
      ["match", "card"],
      ["settled", "slim"],
    ]);
  });

  it("includes a thread matched by message content", () => {
    const thread = makeThread({
      id: ThreadId.make("content-match"),
      title: "Unrelated title",
    });
    const { items } = buildThreadListV2Items({
      threads: [thread],
      environmentId: null,
      searchQuery: "relay reconnect",
      matchedThreadKeys: new Set([
        threadSearchMatchKey({
          environmentId,
          threadId: thread.id,
        }),
      ]),
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["content-match"]);
  });

  it("scopes the flat list to one project", () => {
    const otherProjectId = ProjectId.make("project-2");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("included"), title: "Included" }),
        makeThread({
          id: ThreadId.make("excluded"),
          projectId: otherProjectId,
          title: "Excluded",
        }),
      ],
      environmentId: null,
      projectRefs: [{ environmentId, projectId: ProjectId.make("project-1") }],
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["included"]);
  });

  it("scopes the flat list to every environment member of a logical project", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("local"), title: "Local" }),
        makeThread({
          environmentId: remoteEnvironmentId,
          id: ThreadId.make("remote"),
          title: "Remote",
        }),
      ],
      environmentId: null,
      projectRefs: [
        { environmentId, projectId: ProjectId.make("project-1") },
        { environmentId: remoteEnvironmentId, projectId: ProjectId.make("project-1") },
      ],
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["local", "remote"]);
  });
});

describe("buildThreadListV2Items settled paging", () => {
  it("caps the settled tail at settledLimit and reports the hidden count", () => {
    const threads = [
      makeThread({ id: ThreadId.make("active"), title: "Active" }),
      ...Array.from({ length: 4 }, (_, index) =>
        makeThread({
          id: ThreadId.make(`settled-${index}`),
          title: `Settled ${index}`,
          settledOverride: "settled",
          settledAt: NOW,
          latestUserMessageAt: `2026-06-01T0${index}:00:00.000Z`,
          // A turn adopted the message (same requestedAt): without it the
          // thread reads as a queued turn start, which never settles.
          latestTurn: {
            turnId: TurnId.make(`turn-${index}`),
            state: "completed",
            requestedAt: `2026-06-01T0${index}:00:00.000Z`,
            startedAt: `2026-06-01T0${index}:00:00.000Z`,
            completedAt: `2026-06-01T0${index}:10:00.000Z`,
            assistantMessageId: null,
          },
        }),
      ),
    ];

    const layout = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      settledLimit: 2,
      now: NOW,
    });

    expect(layout.hiddenSettledCount).toBe(2);
    expect(layout.items.filter((item) => item.variant === "slim")).toHaveLength(2);
    // Most recent settled first — the hidden ones are the oldest.
    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "active",
      "settled-3",
      "settled-2",
    ]);
  });
});

function makePendingTask(id: string): PendingNewTask {
  return {
    message: {
      environmentId,
      threadId: ThreadId.make(`thread-${id}`),
      messageId: MessageId.make(id),
      commandId: CommandId.make(`command-${id}`),
      text: id,
      attachments: [],
      createdAt: NOW,
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "worktree",
        branch: null,
        worktreePath: null,
      },
    },
    creation: {
      projectId: ProjectId.make("project-1"),
      workspaceMode: "worktree",
      branch: null,
      worktreePath: null,
    },
    title: id,
  };
}

describe("buildThreadListV2ListItems", () => {
  const layout = buildThreadListV2Items({
    threads: [
      makeThread({ id: ThreadId.make("active"), title: "active" }),
      makeThread({
        id: ThreadId.make("settled"),
        title: "settled",
        settledOverride: "settled",
        settledAt: NOW,
      }),
    ],
    environmentId: null,
    searchQuery: "",
    now: NOW,
  });

  it("splices queued tasks between the active block and the settled tail", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("queued-1"), makePendingTask("queued-2")],
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });

    expect(
      items.map((item) =>
        item.type === "v2-pending"
          ? item.pendingTask.title
          : item.type === "v2-thread"
            ? item.item.thread.id
            : item.type === "v2-snoozed-shelf"
              ? "snoozed-shelf"
              : "settled-shelf",
      ),
    ).toEqual(["active", "queued-1", "queued-2", "settled-shelf", "settled"]);
    // Only the leading queued row labels the section, exactly like Settled.
    expect(
      items.filter((item) => item.type === "v2-pending" && item.showPendingDivider),
    ).toHaveLength(1);
  });

  it("ends the list with queued tasks when nothing has settled yet", () => {
    const activeOnly = buildThreadListV2Items({
      threads: [makeThread({ id: ThreadId.make("active"), title: "active" })],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: activeOnly.items,
      pendingTasks: [makePendingTask("queued-1")],
    });

    expect(items.map((item) => item.type)).toEqual(["v2-thread", "v2-pending"]);
  });

  it("keeps the settled shelf between active and settled rows when nothing is queued", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [],
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });

    expect(items.map((item) => item.key)).toEqual([
      `v2-thread:${environmentId}:active`,
      "v2-settled-shelf",
      `v2-thread:${environmentId}:settled`,
    ]);
  });

  it("places queued tasks before a collapsed snoozed shelf", () => {
    const snoozedLayout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "active" }),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: snoozedLayout.items,
      pendingTasks: [makePendingTask("queued")],
      snoozedCount: snoozedLayout.snoozedCount,
      snoozedShelfExpanded: false,
      snoozedShelfHeaderIndex: snoozedLayout.snoozedShelfHeaderIndex,
      settledCount: snoozedLayout.settledCount,
      settledShelfHeaderIndex: snoozedLayout.settledShelfHeaderIndex,
    });

    expect(items.map((item) => item.type)).toEqual([
      "v2-thread",
      "v2-pending",
      "v2-snoozed-shelf",
      "v2-settled-shelf",
      "v2-thread",
    ]);
  });
});
