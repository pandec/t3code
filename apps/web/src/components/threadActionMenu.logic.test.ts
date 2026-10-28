import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [{ id: "hour", label: "In 1 hour", whenLabel: "3:00 PM" }],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

function allIds(state: ThreadActionMenuState): string[] {
  const flatten = (items: ReturnType<typeof buildThreadActionMenuItems>): string[] =>
    items.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);
  return flatten(buildThreadActionMenuItems(state));
}

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  const forkExtras = { fork: true };

  it("omits the fork-only entries for surfaces that pass no extras", () => {
    expect(ids(baseState)).not.toContain("fork");
    expect(allIds(baseState).filter((id) => id === "copy-thread-id")).toHaveLength(1);
  });

  it("adds the fork-only entries when extras are supplied", () => {
    expect(ids({ ...baseState, forkExtras })).toEqual([
      "pin",
      "settle",
      "snooze",
      "rename",
      "regenerate-title",
      "mark-unread",
      "fork",
      "auto-settle",
      "copy",
      "project-settings",
      "archive",
      "delete",
    ]);
  });

  it("keeps branch copy before the thread and thread ID copies", () => {
    const copyItem = buildThreadActionMenuItems({
      ...baseState,
      branch: "main",
      forkExtras,
    }).find((item) => item.id === "copy");
    expect(copyItem?.children?.map((child) => child.id)).toEqual([
      "copy-path",
      "copy-branch",
      "copy-thread",
      "copy-thread-id",
    ]);
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });

  it("offers archive when done for a busy thread and cancel for a pending archive", () => {
    const busy = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      archiveAction: "schedule",
    });
    expect(busy.find((item) => item.id === "archive-when-done")?.disabled).toBeUndefined();
    expect(busy.some((item) => item.id === "archive")).toBe(false);
    const pending = ids({ ...baseState, archiveAction: "cancel" });
    expect(pending).toContain("cancel-archive");
    expect(pending).not.toContain("archive");
  });
});
