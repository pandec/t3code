import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, type ThreadGroup } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import {
  mergeThreadGroups,
  nextThreadGroupRevision,
  threadGroupId,
  visibleThreadGroups,
} from "./threadGroups.ts";

const group = (id: string, revision = "0000000000000001:a"): ThreadGroup => ({
  id,
  name: id,
  orderKey: id,
  revision,
  deleted: false,
});

describe("thread group replication", () => {
  it("merges independent edits and converges in either arrival order", () => {
    const left = [group("research"), group("parked")];
    const right = [
      { ...group("research", "0000000000000002:b"), name: "Research renamed" },
      group("blocked"),
    ];
    const merged = mergeThreadGroups(left, right);
    expect(merged).toEqual(mergeThreadGroups(right, left));
    expect(merged).toHaveLength(3);
    expect(mergeThreadGroups(merged, left, right)).toEqual(merged);
    expect(merged.find((entry) => entry.id === "research")?.name).toBe("Research renamed");
  });
  it("retains deletion when a stale server reconnects and releases its threads", () => {
    const original = group("parked");
    const deleted = { ...original, revision: "0000000000000002:b", deleted: true };
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { threadGroups: [deleted] });
    const repaired = applyServerSettingsPatch(current, {
      threadGroups: [original, group("research")],
    });
    expect(repaired.threadGroups).toContainEqual(deleted);
    expect(visibleThreadGroups(repaired.threadGroups).map((entry) => entry.id)).toEqual([
      "research",
    ]);
    expect(threadGroupId({ customGroupId: "parked" }, repaired.threadGroups)).toBeNull();
  });
  it("breaks concurrent edit ties deterministically and stamps beyond observed clocks", () => {
    const left = group("research", "0000000000000500:a");
    const right = { ...left, name: "Changed", revision: "0000000000000500:b" };
    expect(mergeThreadGroups([left], [right])).toEqual([right]);
    expect(nextThreadGroupRevision([right], 20, "c")).toBe("0000000000000501:c");
  });
});
