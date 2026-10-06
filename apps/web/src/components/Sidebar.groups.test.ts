import { expect, it } from "vite-plus/test";
import {
  planSidebarThreadDrop,
  resolveSidebarDropTarget,
  sidebarMarkerId,
  type SidebarListItem,
} from "./Sidebar.logic";

const items: SidebarListItem[] = [
  { kind: "marker", marker: "pinned-header" },
  { kind: "thread", key: "env:pinned", section: "pinned" },
  { kind: "marker", marker: "pinned-divider" },
  { kind: "marker", marker: "custom-group:research" },
  { kind: "thread", key: "env:research", section: "active", customGroupId: "research" },
  { kind: "marker", marker: "custom-group:empty" },
  { kind: "marker", marker: "active-header" },
  { kind: "thread", key: "env:active", section: "active" },
  { kind: "marker", marker: "settled-header" },
];

it("drops into empty or collapsed groups from either direction", () => {
  for (const key of ["env:pinned", "env:active"]) {
    expect(
      resolveSidebarDropTarget(items, key, sidebarMarkerId("custom-group:empty")),
    ).toMatchObject({ section: "active", customGroupId: "empty", activeOrder: [key] });
  }
});
it("keeps reordering inside the destination group and supports returning to Active", () => {
  expect(
    resolveSidebarDropTarget(items, "env:active", sidebarMarkerId("custom-group:research")),
  ).toMatchObject({ customGroupId: "research", activeOrder: ["env:active", "env:research"] });
  expect(
    resolveSidebarDropTarget(items, "env:research", sidebarMarkerId("active-header")),
  ).toMatchObject({ customGroupId: null, activeOrder: ["env:research", "env:active"] });
});
it("reaches the last slot of a group from below through the next header", () => {
  const expanded: SidebarListItem[] = [
    { kind: "marker", marker: "pinned-divider" },
    { kind: "marker", marker: "custom-group:research" },
    { kind: "thread", key: "env:research", section: "active", customGroupId: "research" },
    { kind: "marker", marker: "active-header" },
    { kind: "marker", marker: "active-placeholder" },
    { kind: "thread", key: "env:active1", section: "active" },
    { kind: "thread", key: "env:active2", section: "active" },
    { kind: "marker", marker: "settled-header" },
  ];
  // From below, the Active header closes the group above it.
  expect(
    resolveSidebarDropTarget(expanded, "env:active2", sidebarMarkerId("active-header")),
  ).toMatchObject({ customGroupId: "research", activeOrder: ["env:research", "env:active2"] });
  // Also when the dragged row is the group's only visible row.
  expect(
    resolveSidebarDropTarget(
      expanded.filter((item) => item.kind !== "thread" || item.key !== "env:active1"),
      "env:active2",
      sidebarMarkerId("active-header"),
    ),
  ).toMatchObject({ customGroupId: "research", activeOrder: ["env:research", "env:active2"] });
  // From above, it still opens Active's first slot.
  expect(
    resolveSidebarDropTarget(expanded, "env:research", sidebarMarkerId("active-header")),
  ).toMatchObject({
    customGroupId: null,
    activeOrder: ["env:research", "env:active1", "env:active2"],
  });
});
it("drops below the pinned divider into the group that follows it", () => {
  expect(
    resolveSidebarDropTarget(items, "env:pinned", sidebarMarkerId("pinned-divider")),
  ).toMatchObject({
    section: "active",
    customGroupId: "research",
    activeOrder: ["env:pinned", "env:research"],
  });
  expect(
    resolveSidebarDropTarget(items, "env:research", sidebarMarkerId("pinned-divider")),
  ).toMatchObject({ section: "pinned", pinnedOrder: ["env:pinned", "env:research"] });
});
it("does not mistake a one-thread group move for an unchanged order", () => {
  expect(
    planSidebarThreadDrop({
      activeKey: "env:a",
      activeSection: "active",
      activeCustomGroupId: null,
      target: {
        section: "active",
        customGroupId: "research",
        activeOrder: ["env:a"],
        pinnedOrder: [],
      },
      activeOrder: ["env:a"],
      activeKeysById: new Map([["env:a", "m"]]),
      pinnedOrder: [],
      pinnedKeysById: new Map(),
    }).kind,
  ).toBe("move-active");
});

it("releases a held group drop only for a competing move", async () => {
  const { shouldReleaseSidebarGroupDrop } = await import("./Sidebar.logic");
  const pending = {
    sourceGroupId: "source",
    targetGroupId: "target",
    currentGroupId: "source",
    targetExists: true,
    targetSeen: false,
  };
  // The source group before the target shows is lag, not a conflict.
  expect(shouldReleaseSidebarGroupDrop(pending)).toBe(false);
  expect(shouldReleaseSidebarGroupDrop({ ...pending, targetSeen: true })).toBe(true);
  expect(shouldReleaseSidebarGroupDrop({ ...pending, currentGroupId: "third" })).toBe(true);
  expect(
    shouldReleaseSidebarGroupDrop({ ...pending, currentGroupId: "target", targetSeen: true }),
  ).toBe(false);
  expect(shouldReleaseSidebarGroupDrop({ ...pending, targetExists: false })).toBe(true);
});

it("moves between groups in a time-ordered inbox without placement", () => {
  expect(
    planSidebarThreadDrop({
      activeKey: "env:a",
      activeSection: "active",
      activeCustomGroupId: null,
      target: {
        section: "active",
        customGroupId: "research",
        activeOrder: ["env:a"],
        pinnedOrder: [],
      },
      activeOrder: ["env:a"],
      activeKeysById: new Map([["env:a", "m"]]),
      pinnedOrder: [],
      pinnedKeysById: new Map(),
      activeTimeOrdered: true,
    }),
  ).toMatchObject({ kind: "move-active", order: null });
});

it("does not carry a group into Settled when custom groups are below Active", () => {
  const belowActive: SidebarListItem[] = [
    { kind: "marker", marker: "pinned-header" },
    { kind: "marker", marker: "pinned-divider" },
    { kind: "marker", marker: "active-header" },
    { kind: "thread", key: "active", section: "active" },
    { kind: "marker", marker: "custom-group:research" },
    { kind: "thread", key: "research", section: "active", customGroupId: "research" },
    { kind: "marker", marker: "settled-header" },
    { kind: "thread", key: "settled", section: "settled" },
  ];
  for (const source of ["active", "research"]) {
    for (const target of [sidebarMarkerId("settled-header"), "settled"]) {
      expect(resolveSidebarDropTarget(belowActive, source, target)).toMatchObject({
        section: "settled",
        customGroupId: null,
      });
    }
  }
});
