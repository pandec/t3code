import { expect, it } from "vite-plus/test";
import type { ThreadGroup } from "@t3tools/contracts";
import {
  mergeThreadGroups,
  threadGroupSections,
  visibleThreadGroups,
} from "@t3tools/shared/threadGroups";
import { newThreadGroupOrderKey, planThreadGroupMove } from "./ThreadGroupsDialog.logic";

const groups: ThreadGroup[] = ["b", "m", "z"].map((orderKey, index) => ({
  id: String(index),
  name: String(index),
  orderKey,
  deleted: false,
  revision: "1",
}));

/** Dialog row ids after applying `moved` as a newer revision, with null
 * standing for the Active divider. */
const rowsAfter = (moved: ThreadGroup | null, base = groups) =>
  threadGroupSections(
    visibleThreadGroups(mergeThreadGroups(base, moved ? [{ ...moved, revision: "9" }] : [])),
  ).map((group) => group?.id ?? null);

it("reorders one entry without overwriting a disconnected rename or deletion", () => {
  // Rows: Active, 0, 1, 2. Moving row 2 (group "1") up lands it before "0".
  const moved = planThreadGroupMove(groups, 2, -1)!;
  const remote = [{ ...groups[2]!, name: "Renamed", deleted: true, revision: "2" }];
  const merged = mergeThreadGroups(groups, remote, [{ ...moved, revision: "3" }]);
  expect(visibleThreadGroups(merged).map((group) => group.id)).toEqual(["1", "0"]);
  expect(merged.find((group) => group.id === "2")).toEqual(remote[0]);
  expect(rowsAfter(planThreadGroupMove(groups, 1, 1))).toEqual([null, "1", "0", "2"]);
});

it("moves groups across the Active divider and back", () => {
  const up = planThreadGroupMove(groups, 1, -1)!;
  expect(up).toMatchObject({ id: "0", aboveActive: true });
  const above = visibleThreadGroups(mergeThreadGroups(groups, [{ ...up, revision: "3" }]));
  expect(threadGroupSections(above).map((group) => group?.id ?? null)).toEqual([
    "0",
    null,
    "1",
    "2",
  ]);
  // Rows: 0, Active, 1, 2. Moving "1" up lands it below "0" on the above side.
  const second = planThreadGroupMove(above, 2, -1)!;
  expect(second).toMatchObject({ id: "1", aboveActive: true });
  expect(second.orderKey > up.orderKey).toBe(true);
  expect(rowsAfter(second, above)).toEqual(["0", "1", null, "2"]);
  // Moving "0" down crosses back and lands at the top of the below side.
  const down = planThreadGroupMove(above, 0, 1)!;
  expect(down).toMatchObject({ id: "0", aboveActive: false });
  expect(down.orderKey < "m").toBe(true);
  expect(rowsAfter(down, above)).toEqual([null, "0", "1", "2"]);
});

it("rejects moves past the first or last row", () => {
  expect(planThreadGroupMove(groups, 1, -2)).toBeNull();
  expect(planThreadGroupMove(groups, 3, 1)).toBeNull();
  expect(planThreadGroupMove(groups, 0, -1)).toBeNull();
});

it("moves past equal keys from concurrent creation in either direction", () => {
  const tied = groups.map((group) => ({ ...group, orderKey: "m" }));
  // Rows: Active, 0, 1, 2. Moving the last group up clears the tied run above it.
  expect(planThreadGroupMove(tied, 3, -1)!.orderKey < "m").toBe(true);
  expect(planThreadGroupMove(tied, 1, 1)!.orderKey > "m").toBe(true);
});

it("creates new groups at the bottom of the below side", () => {
  expect(newThreadGroupOrderKey([])).toBe("n");
  expect(newThreadGroupOrderKey(groups) > "z").toBe(true);
  const allAbove = groups.map((group) => ({ ...group, aboveActive: true }));
  expect(newThreadGroupOrderKey(allAbove)).toBe("n");
  const mixed = [{ ...groups[0]!, aboveActive: true }, groups[1]!];
  const key = newThreadGroupOrderKey(mixed);
  expect(key > "m" && key < "z").toBe(true);
});
