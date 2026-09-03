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
  resolveThreadListV2ArchiveQueueEnabled,
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

  it("holds the default UI but disables offline archive while preferences load", () => {
    const loading = { legacyPreference: undefined, preferencesLoaded: false };
    expect(resolveThreadListV2Enabled(loading)).toBe(true);
    expect(resolveThreadListV2ArchiveQueueEnabled(loading)).toBe(false);
    expect(
      resolveThreadListV2ArchiveQueueEnabled({
        legacyPreference: undefined,
        preferencesLoaded: true,
      }),
    ).toBe(true);
    expect(
      resolveThreadListV2ArchiveQueueEnabled({
        legacyPreference: true,
        preferencesLoaded: true,
      }),
    ).toBe(false);
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
    ).toEqual({ primary: "settle", secondary: "snooze", left: ["archive"] });
  });

  it("offers un-settle and snooze for settled history", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "unsettle", secondary: "snooze", left: ["archive"] });
  });

  it("omits snooze when the server or thread does not allow it", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "settle", secondary: null, left: ["archive"] });
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: false,
      }),
    ).toEqual({ primary: "settle", secondary: null, left: ["archive"] });
  });

  it("falls back to archive only for a pre-lifecycle server", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: false,
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "archive", secondary: null, left: [] });
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
    ).toEqual({ primary: "unsnooze", secondary: null, left: ["archive"] });
  });

  it("orders the leading panel pin, fork, archive so a full swipe still archives", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
        pinnable: true,
        forkable: true,
      }).left,
    ).toEqual(["pin", "fork", "archive"]);
  });

  it("flips the leading pin action on a pinned row", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
        pinnable: true,
        pinned: true,
        forkable: true,
      }).left,
    ).toEqual(["unpin", "fork", "archive"]);
  });

  it("drops pin where the row menu has none: unsupported servers and settled rows", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
        pinnable: false,
        forkable: true,
      }).left,
    ).toEqual(["fork", "archive"]);
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
        pinnable: true,
        forkable: true,
      }).left,
    ).toEqual(["fork", "archive"]);
  });

  it("drops fork for threads that cannot be forked", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
        pinnable: true,
        forkable: false,
      }).left,
    ).toEqual(["pin", "archive"]);
  });

  it("keeps the snoozed shelf on archive alone", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
        snoozed: true,
        pinnable: true,
        forkable: true,
      }).left,
    ).toEqual(["archive"]);
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

  it("surfaces an un-settled thread at the top via its re-entry stamp", () => {
    const sorted = sortThreadsForListV2([
      {
        id: "old-unsettled",
        createdAt: "2026-06-01T08:00:00.000Z",
        unsettledAt: "2026-06-01T13:00:00.000Z",
      },
      { id: "newest", createdAt: "2026-06-01T12:00:00.000Z" },
      { id: "middle", createdAt: "2026-06-01T10:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["old-unsettled", "newest", "middle"]);
  });

  // The un-settle re-anchor and the fork's explicit bump are independent
  // anchors on the same axis, so the newer of the two wins either way.
  it("takes the newest of the un-settle stamp and an explicit move-to-top", () => {
    const bumpedLater = sortThreadsForListV2([
      {
        id: "unsettled",
        createdAt: "2026-06-01T08:00:00.000Z",
        unsettledAt: "2026-06-01T13:00:00.000Z",
      },
      {
        id: "bumped",
        createdAt: "2026-06-01T07:00:00.000Z",
        movedToTopAt: "2026-06-01T14:00:00.000Z",
      },
    ]);
    expect(bumpedLater.map((thread) => thread.id)).toEqual(["bumped", "unsettled"]);

    const unsettledLater = sortThreadsForListV2([
      {
        id: "unsettled",
        createdAt: "2026-06-01T08:00:00.000Z",
        unsettledAt: "2026-06-01T15:00:00.000Z",
      },
      {
        id: "bumped",
        createdAt: "2026-06-01T07:00:00.000Z",
        movedToTopAt: "2026-06-01T14:00:00.000Z",
      },
    ]);
    expect(unsettledLater.map((thread) => thread.id)).toEqual(["unsettled", "bumped"]);
  });

  // An imported thread carries a fresh createdAt with its original message
  // timestamps, so folding createdAt into the key would sort every import as
  // brand new and bury genuinely recent conversations.
  it("does not floor the latest-user-message key with creation time", () => {
    const sorted = sortThreadsForListV2(
      [
        {
          id: "imported",
          createdAt: "2026-06-01T18:00:00.000Z",
          latestUserMessageAt: "2026-01-05T10:00:00.000Z",
        },
        {
          id: "recent",
          createdAt: "2026-05-30T08:00:00.000Z",
          latestUserMessageAt: "2026-06-01T09:00:00.000Z",
        },
      ],
      { sortByLatestUserMessage: true },
    );
    expect(sorted.map((thread) => thread.id)).toEqual(["recent", "imported"]);
  });

  it("re-anchors on un-settle even when sorting by the latest user message", () => {
    const sorted = sortThreadsForListV2(
      [
        {
          id: "messaged",
          createdAt: "2026-06-01T08:00:00.000Z",
          latestUserMessageAt: "2026-06-01T14:00:00.000Z",
        },
        {
          id: "unsettled",
          createdAt: "2026-06-01T07:00:00.000Z",
          latestUserMessageAt: "2026-06-01T09:00:00.000Z",
          unsettledAt: "2026-06-01T15:00:00.000Z",
        },
      ],
      { sortByLatestUserMessage: true },
    );
    expect(sorted.map((thread) => thread.id)).toEqual(["unsettled", "messaged"]);
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

  it("places a persisted settled thread in the settled shelf", () => {
    const thread = makeThread({
      id: ThreadId.make("server-settled"),
      title: "Server-settled thread",
      settledOverride: "settled",
      settledAt: NOW,
    });
    const layout = buildThreadListV2Items({
      threads: [thread],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.settledCount).toBe(1);
    expect(layout.items[0]?.variant).toBe("slim");
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

  it("keeps active pinned threads in the pinned block", () => {
    const pinned = makeThread({
      id: ThreadId.make("pinned"),
      title: "Pinned thread",
      pinnedAt: "2026-06-01T12:00:00.000Z",
    });
    const layout = buildThreadListV2Items({
      threads: [pinned],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items[0]).toMatchObject({
      thread: { id: "pinned" },
      variant: "card",
      pinned: true,
    });
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

    const expandedSnoozed = buildThreadListV2Items({
      ...snoozedInput,
      now: NOW,
      snoozedShelfExpanded: true,
    });
    expect(expandedSnoozed.items[1]).toMatchObject({
      thread: { id: "pinned-snoozed" },
      variant: "slim",
      snoozed: true,
      pinned: true,
    });

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
      now: "2026-06-02T00:01:07.500Z",
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

  it("sorts settled threads by their persisted settlement timestamp", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("settled-newer"),
          title: "Settled newer",
          settledOverride: "settled",
          settledAt: "2026-06-01T12:00:00.000Z",
          latestUserMessageAt: "2026-06-01T08:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled-older"),
          title: "Settled older",
          settledOverride: "settled",
          settledAt: "2026-06-01T10:00:00.000Z",
          latestUserMessageAt: "2026-06-01T09:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["settled-newer", "settled-older"]);
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
          settledAt: `2026-06-01T0${index}:10:00.000Z`,
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

  it("opens the pinned block with a shelf header and closes it with a divider", () => {
    const pinnedLayout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "active" }),
        makeThread({
          id: ThreadId.make("pinned"),
          title: "pinned",
          pinnedAt: "2026-06-01T10:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: pinnedLayout.items,
      pendingTasks: [makePendingTask("queued")],
      pinnedCount: pinnedLayout.pinnedCount,
      pinnedShelfExpanded: true,
    });

    expect(items.map((item) => item.key)).toEqual([
      "v2-pinned-shelf",
      `v2-thread:${environmentId}:pinned`,
      "v2-pinned-divider",
      `v2-thread:${environmentId}:active`,
      "v2-pending:queued",
    ]);
  });

  it("collapses the pinned shelf to its header, keeping only the open thread", () => {
    const threads = [
      makeThread({ id: ThreadId.make("active"), title: "active" }),
      makeThread({
        id: ThreadId.make("pinned-a"),
        title: "pinned a",
        pinnedAt: "2026-06-01T10:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("pinned-b"),
        title: "pinned b",
        pinnedAt: "2026-06-01T11:00:00.000Z",
      }),
    ];
    const collapsed = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      now: NOW,
      pinnedShelfExpanded: false,
      selectedThreadKey: `${environmentId}:pinned-a`,
    });
    expect(collapsed.pinnedCount).toBe(2);

    const items = buildThreadListV2ListItems({
      items: collapsed.items,
      pendingTasks: [],
      pinnedCount: collapsed.pinnedCount,
      pinnedShelfExpanded: false,
    });
    expect(items.map((item) => item.key)).toEqual([
      "v2-pinned-shelf",
      `v2-thread:${environmentId}:pinned-a`,
      "v2-pinned-divider",
      `v2-thread:${environmentId}:active`,
    ]);
    const header = items[0];
    expect(header?.type === "v2-pinned-shelf" && header.expanded).toBe(false);
    expect(header?.type === "v2-pinned-shelf" && header.count).toBe(2);
  });

  it("ignores the pinned collapse while searching or the Attention filter is on", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("pinned"),
        title: "pinned needle",
        pinnedAt: "2026-06-01T10:00:00.000Z",
      }),
    ];
    const searched = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "needle",
      now: NOW,
      pinnedShelfExpanded: false,
    });
    expect(searched.items.map((item) => item.thread.id)).toEqual(["pinned"]);
    expect(searched.pinnedShelfHeaderVisible).toBe(false);

    const attention = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      now: NOW,
      pinnedShelfExpanded: false,
      attentionMemberThreadKeys: new Set([`${environmentId}:pinned`]),
    });
    expect(attention.items.map((item) => item.thread.id)).toEqual(["pinned"]);
    expect(attention.pinnedShelfHeaderVisible).toBe(false);

    const items = buildThreadListV2ListItems({
      items: searched.items,
      pendingTasks: [],
      pinnedCount: searched.pinnedCount,
      pinnedShelfExpanded: false,
      pinnedShelfHeaderVisible: searched.pinnedShelfHeaderVisible,
    });
    expect(items.map((item) => item.key)).toEqual([
      `v2-thread:${environmentId}:pinned`,
      "v2-pinned-divider",
    ]);
  });

  it("omits the pinned divider when nothing is pinned", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [],
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });

    expect(items.some((item) => item.type === "v2-pinned-divider")).toBe(false);
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

/** Fork addition: the Older display shelf for quiet active threads. */
describe("buildThreadListV2Items older section", () => {
  const QUIET_SINCE = "2026-05-01T00:00:00.000Z";
  const quietThread = (input: Partial<EnvironmentThreadShell> = {}) =>
    makeThread({
      id: ThreadId.make("quiet"),
      title: "quiet",
      createdAt: QUIET_SINCE,
      updatedAt: QUIET_SINCE,
      latestUserMessageAt: QUIET_SINCE,
      ...input,
    });
  const olderInput = {
    environmentId: null,
    searchQuery: "",
    now: NOW,
    olderSectionEnabled: true,
    olderShelfExpanded: true,
  } as const;

  it("keeps a quiet thread active until the server projects settlement", () => {
    const layout = buildThreadListV2Items({
      threads: [quietThread()],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.settledCount).toBe(0);
    expect(layout.items.map((item) => item.variant)).toEqual(["card"]);
  });

  it("files a quiet thread under Older with its own header", () => {
    const layout = buildThreadListV2Items({ ...olderInput, threads: [quietThread()] });

    expect(layout.olderCount).toBe(1);
    expect(layout.olderShelfHeaderIndex).toBe(0);
    // Older rows stay ordinary active cards, not the settled tail's slim rows.
    expect(layout.items.map((item) => item.variant)).toEqual(["card"]);
  });

  it("lets server-projected settlement outrank Older", () => {
    const layout = buildThreadListV2Items({
      ...olderInput,
      threads: [quietThread({ settledOverride: "settled", settledAt: NOW })],
    });

    expect(layout.settledCount).toBe(1);
    expect(layout.olderCount).toBe(0);
  });

  it("ages a thread that was opened and never used", () => {
    const layout = buildThreadListV2Items({
      ...olderInput,
      // No message and no turn: creation time still lets the display-only
      // Older shelf file the quiet thread.
      threads: [quietThread({ latestUserMessageAt: null })],
    });

    expect(layout.olderCount).toBe(1);
  });

  it("never folds away live or blocked work, however long it has sat there", () => {
    const layout = buildThreadListV2Items({
      ...olderInput,
      threads: [
        quietThread({ id: ThreadId.make("approval"), hasPendingApprovals: true }),
        quietThread({ id: ThreadId.make("input"), hasPendingUserInput: true }),
        quietThread({ id: ThreadId.make("plan"), hasActionableProposedPlan: true }),
        quietThread({
          id: ThreadId.make("running"),
          session: {
            threadId: ThreadId.make("running"),
            status: "running",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: QUIET_SINCE,
          },
        }),
        quietThread({ id: ThreadId.make("background"), backgroundLiveness: "working" }),
      ],
    });

    expect(layout.olderCount).toBe(0);
    expect(layout.olderShelfHeaderIndex).toBeNull();
  });

  it("steps aside entirely while the attention filter is on", () => {
    const layout = buildThreadListV2Items({
      ...olderInput,
      threads: [quietThread()],
      attentionMemberThreadKeys: new Set([`${environmentId}:quiet`]),
    });

    expect(layout.olderCount).toBe(0);
  });

  it("steps aside while a search is active, so a match can never hide behind the fold", () => {
    const layout = buildThreadListV2Items({
      ...olderInput,
      olderShelfExpanded: false,
      searchQuery: "quiet",
      threads: [quietThread()],
    });

    expect(layout.olderCount).toBe(0);
    expect(layout.items.map((item) => item.thread.id)).toEqual(["quiet"]);
  });

  it("keeps the open thread's row on a folded shelf", () => {
    const layout = buildThreadListV2Items({
      ...olderInput,
      olderShelfExpanded: false,
      threads: [quietThread(), quietThread({ id: ThreadId.make("quiet-2"), title: "quiet 2" })],
      selectedThreadKey: `${environmentId}:quiet-2`,
    });

    expect(layout.olderCount).toBe(2);
    expect(layout.items.map((item) => item.thread.id)).toEqual(["quiet-2"]);
  });

  it("orders the shelf by the recency that filed the rows there", () => {
    const layout = buildThreadListV2Items({
      ...olderInput,
      threads: [
        quietThread({ id: ThreadId.make("oldest"), createdAt: "2026-04-01T00:00:00.000Z" }),
        quietThread({ id: ThreadId.make("newest"), createdAt: "2026-05-20T00:00:00.000Z" }),
      ],
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["newest", "oldest"]);
  });

  it("places the Older shelf after queued tasks and before the snoozed shelf", () => {
    const layout = buildThreadListV2Items({
      ...olderInput,
      snoozedShelfExpanded: true,
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "active" }),
        quietThread(),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
    });
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("queued")],
      olderCount: layout.olderCount,
      olderShelfExpanded: true,
      olderShelfHeaderIndex: layout.olderShelfHeaderIndex,
      snoozedCount: layout.snoozedCount,
      snoozedShelfExpanded: true,
      snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });

    expect(items.map((item) => item.key)).toEqual([
      `v2-thread:${environmentId}:active`,
      "v2-pending:queued",
      "v2-older-shelf",
      `v2-thread:${environmentId}:quiet`,
      "v2-snoozed-shelf",
      `v2-thread:${environmentId}:snoozed`,
    ]);
  });
});
