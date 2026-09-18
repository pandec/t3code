import { describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DEFAULT_SERVER_SETTINGS,
  ExecutionEnvironmentCapabilities,
  ServerSettings,
  ServerSettingsPatch,
  type ThreadGroup,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import {
  canSyncThreadGroups,
  mergeThreadGroups,
  retryThreadGroupSync,
  nextThreadGroupRevision,
  threadGroupId,
  threadGroupSections,
  visibleThreadGroups,
} from "./threadGroups.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);
const decodePatch = Schema.decodeSync(ServerSettingsPatch);

const group = (id: string, revision = "0000000000000001:a"): ThreadGroup => ({
  id,
  name: id,
  orderKey: id,
  revision,
  deleted: false,
});

describe("thread group replication", () => {
  it("excludes older servers from catalog writes and repair pushes", () => {
    const decodeCapabilities = Schema.decodeSync(ExecutionEnvironmentCapabilities);
    expect(canSyncThreadGroups(undefined)).toBe(false);
    expect(canSyncThreadGroups(decodeCapabilities({}))).toBe(false);
    expect(canSyncThreadGroups(decodeCapabilities({ threadCustomGroups: true }))).toBe(false);
    expect(
      canSyncThreadGroups(
        decodeCapabilities({ threadCustomGroups: true, threadGroupPlacement: false }),
      ),
    ).toBe(false);
    expect(
      canSyncThreadGroups(
        decodeCapabilities({ threadCustomGroups: true, threadGroupPlacement: true }),
      ),
    ).toBe(true);
  });

  it("retains explicit placement when an older client echoes the same revision without it", () => {
    const stripped = group("a");
    for (const aboveActive of [true, false]) {
      // Exercise both a client-created object and the contract's decoded key order.
      const edited = { ...stripped, aboveActive };
      for (const current of [edited, decodeSettings({ threadGroups: [edited] }).threadGroups[0]!]) {
        expect(mergeThreadGroups([current], [stripped])).toEqual([current]);
        expect(mergeThreadGroups([stripped], [current])).toEqual([current]);
        const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
          threadGroups: [current],
        });
        expect(applyServerSettingsPatch(settings, { threadGroups: [stripped] })).toEqual(settings);
      }
    }
    // A real newer edit still wins, including deletion from an older client.
    const deleted = { ...stripped, revision: "0000000000000002:b", deleted: true };
    expect(mergeThreadGroups([{ ...stripped, aboveActive: true }], [deleted])).toEqual([deleted]);
  });

  it("defaults old catalogs below Active and syncs placement with each group's revision", () => {
    const original = [group("a"), group("b"), group("c")];
    const legacy = decodeSettings({ threadGroups: original });
    expect(
      threadGroupSections(visibleThreadGroups(legacy.threadGroups)).map((g) => g?.id ?? null),
    ).toEqual([null, "a", "b", "c"]);
    const patch = decodePatch({
      threadGroups: [{ ...original[1]!, aboveActive: true, revision: "0000000000000002:b" }],
    });
    const updated = applyServerSettingsPatch(legacy, patch);
    const reconnected = applyServerSettingsPatch(updated, { threadGroups: original });
    expect(reconnected.threadGroups).toEqual(updated.threadGroups);
    expect(
      threadGroupSections(visibleThreadGroups(reconnected.threadGroups)).map((g) => g?.id ?? null),
    ).toEqual(["b", null, "a", "c"]);
    expect(mergeThreadGroups(original, updated.threadGroups)).toEqual(
      mergeThreadGroups(updated.threadGroups, original),
    );

    const restored = applyServerSettingsPatch(
      updated,
      decodePatch({
        threadGroups: [{ ...original[1]!, aboveActive: false, revision: "0000000000000003:c" }],
      }),
    );
    expect(
      threadGroupSections(visibleThreadGroups(restored.threadGroups)).map((g) => g?.id ?? null),
    ).toEqual([null, "a", "b", "c"]);
    expect(threadGroupSections([])).toEqual([null]);
  });
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

it("rejects revisions that cannot participate in the generated revision order", () => {
  for (const revision of ["z", "123:edit", "0000000000000001:"]) {
    const threadGroups = [{ ...group("research"), revision }];
    expect(() => decodeSettings({ threadGroups })).toThrow();
    expect(() => decodePatch({ threadGroups })).toThrow();
  }
  const threadGroups = [
    { ...group("research"), revision: nextThreadGroupRevision([], 123, "edit") },
  ];
  expect(decodePatch({ threadGroups }).threadGroups).toEqual(threadGroups);
});

it("retries transient catalog failures, bounds retries, and cancels stale work", async () => {
  vi.useFakeTimers();
  try {
    const persist = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const controller = new AbortController();
    const recovered = retryThreadGroupSync(persist, controller.signal);
    await vi.runAllTimersAsync();
    await recovered;
    expect(persist).toHaveBeenCalledTimes(2);

    const failing = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const exhausted = retryThreadGroupSync(failing, controller.signal);
    await vi.runAllTimersAsync();
    await exhausted;
    expect(failing).toHaveBeenCalledTimes(3);

    const stale = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const cancelled = retryThreadGroupSync(stale, controller.signal);
    await Promise.resolve();
    controller.abort();
    await cancelled;
    await vi.runAllTimersAsync();
    expect(stale).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
