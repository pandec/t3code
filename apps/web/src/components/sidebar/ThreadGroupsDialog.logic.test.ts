import { expect, it } from "vite-plus/test";
import type { ThreadGroup } from "@t3tools/contracts";
import { mergeThreadGroups, visibleThreadGroups } from "@t3tools/shared/threadGroups";
import { planThreadGroupMove } from "./ThreadGroupsDialog.logic";

const groups: ThreadGroup[] = ["b", "m", "z"].map((orderKey, index) => ({
  id: String(index),
  name: String(index),
  orderKey,
  deleted: false,
  revision: "1",
}));

it("reorders one entry without overwriting a disconnected rename or deletion", () => {
  const moved = planThreadGroupMove(groups, 1, -1)!;
  const remote = [{ ...groups[2]!, name: "Renamed", deleted: true, revision: "2" }];
  const merged = mergeThreadGroups(groups, remote, [{ ...moved, revision: "3" }]);
  expect(visibleThreadGroups(merged).map((group) => group.id)).toEqual(["1", "0"]);
  expect(merged.find((group) => group.id === "2")).toEqual(remote[0]);
  expect(
    visibleThreadGroups(
      mergeThreadGroups(groups, [{ ...planThreadGroupMove(groups, 0, 1)!, revision: "3" }]),
    ).map((group) => group.id),
  ).toEqual(["1", "0", "2"]);
});

it("moves past equal keys from concurrent creation in either direction", () => {
  const tied = groups.map((group) => ({ ...group, orderKey: "m" }));
  expect(planThreadGroupMove(tied, 2, -1)!.orderKey < "m").toBe(true);
  expect(planThreadGroupMove(tied, 0, 1)!.orderKey > "m").toBe(true);
});
