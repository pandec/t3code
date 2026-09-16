import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import { EnvironmentId, ThreadId, type ThreadGroup } from "@t3tools/contracts";
import { planThreadMoveToTop } from "./threadMoveToTop";

type Input = Parameters<typeof planThreadMoveToTop>[0];
type Row = Input["threads"][number];
const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const now = "2026-09-16T12:00:00.000Z";
const groups: ThreadGroup[] = [
  { id: "research", name: "Research", orderKey: "m", revision: "1", deleted: false },
];

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id: ThreadId.make(id),
    environmentId: local,
    createdAt: now,
    archivedAt: null,
    settledOverride: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: null,
    ...overrides,
  };
}

function key(thread: Row) {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function plan(threads: readonly Row[], moved: Row, overrides: Partial<Input> = {}) {
  return planThreadMoveToTop({
    threads,
    threadRef: scopeThreadRef(moved.environmentId, moved.id),
    groups,
    now,
    canReorder: () => true,
    ...overrides,
  });
}

function apply(threads: readonly Row[], result: NonNullable<ReturnType<typeof plan>>) {
  const assignments = new Map(
    result.assignments.map(({ threadRef, orderKey }) => [scopedThreadKey(threadRef), orderKey]),
  );
  return threads.map((thread) => {
    const orderKey = assignments.get(key(thread));
    return orderKey === undefined
      ? thread
      : { ...thread, [result.section === "pinned" ? "pinOrderKey" : "activeOrderKey"]: orderKey };
  });
}

describe("planThreadMoveToTop", () => {
  it("reorders Pinned with one write, regardless of retained custom-group membership", () => {
    const first = row("first", { pinnedAt: now, pinOrderKey: "f" });
    const moved = row("moved", {
      pinnedAt: now,
      pinOrderKey: "t",
      customGroupId: "research",
    });
    const active = row("active", { customGroupId: "research", activeOrderKey: "m" });
    const result = plan([first, moved, active], moved)!;
    expect(result.section).toBe("pinned");
    expect(result.assignments).toHaveLength(1);
    expect(sortPinnedThreadsByOrderKey(apply([first, moved], result)).map(key)).toEqual([
      key(moved),
      key(first),
    ]);
    expect(apply([active], result)).toEqual([active]);
  });

  it("moves above new and reopened Active threads across environments, preserving the rest", () => {
    const newest = row("same-id", { environmentId: remote });
    const reopened = row("reopened", {
      createdAt: "2026-09-15T12:00:00.000Z",
      unsettledAt: "2026-09-16T11:00:00.000Z",
    });
    const moved = row("same-id", { activeOrderKey: "t" });
    const arranged = row("arranged", { activeOrderKey: "m" });
    const rows = [arranged, moved, reopened, newest];
    const result = plan(rows, moved)!;
    expect(result.assignments).toHaveLength(4);
    expect(sortActiveThreadsByOrderKey(apply(rows, result)).map(key)).toEqual([
      key(moved),
      key(newest),
      key(reopened),
      key(arranged),
    ]);
  });

  it("orders the full custom group while leaving other groups and shelves untouched", () => {
    const first = row("first", { customGroupId: "research" });
    const moved = row("moved", { customGroupId: "research", activeOrderKey: "t" });
    const untouched = [
      row("active", { activeOrderKey: "m" }),
      row("archived", { customGroupId: "research", archivedAt: now }),
      row("settled", { customGroupId: "research", settledOverride: "settled" }),
      row("snoozed", { customGroupId: "research", snoozedAt: now }),
      row("pinned", { customGroupId: "research", pinnedAt: now }),
    ];
    const rows = [first, moved, ...untouched];
    const result = plan(rows, moved)!;
    expect(result.assignments.map(({ threadRef }) => scopedThreadKey(threadRef))).toEqual([
      key(moved),
      key(first),
    ]);
    expect(sortActiveThreadsByOrderKey(apply([first, moved], result)).map(key)).toEqual([
      key(moved),
      key(first),
    ]);
    expect(apply(untouched, result)).toEqual(untouched);
    expect(result.assignments.every(({ orderKey }) => orderKey !== "m")).toBe(true);
  });

  it("treats deleted group membership as Active, like the sidebar", () => {
    const first = row("first", { activeOrderKey: "f" });
    const moved = row("moved", { customGroupId: "research", activeOrderKey: "t" });
    const result = plan([first, moved], moved, {
      groups: groups.map((group) => ({ ...group, deleted: true })),
    })!;
    expect(sortActiveThreadsByOrderKey(apply([first, moved], result)).map(key)).toEqual([
      key(moved),
      key(first),
    ]);
  });

  it.each([
    { archivedAt: now },
    { settledOverride: "settled" as const },
    { snoozedAt: now },
    { snoozedAt: now, pinnedAt: now },
    { snoozedUntil: "2026-09-17T12:00:00.000Z" },
  ])("excludes unavailable lifecycle states: %j", (overrides) => {
    const moved = row("moved", overrides);
    expect(plan([row("first"), moved], moved)).toBeNull();
  });

  it("allows an expired snooze and excludes drafts or missing threads", () => {
    const moved = row("moved", {
      snoozedUntil: "2026-09-16T11:00:00.000Z",
      activeOrderKey: "t",
    });
    const rows = [row("first", { activeOrderKey: "f" }), moved];
    expect(plan(rows, moved)?.assignments).toHaveLength(1);
    expect(plan(rows, moved, { threadRef: null })).toBeNull();
    expect(plan(rows, row("draft"))).toBeNull();
  });

  it("does not write for an already-first or only thread", () => {
    const moved = row("moved", { activeOrderKey: "f" });
    for (const rows of [[moved], [moved, row("last", { activeOrderKey: "t" })]]) {
      expect(plan(rows, moved)).toMatchObject({
        assignments: [],
        disabledReason: "Already at top",
      });
    }
  });

  it("requires server support for every needed write, but allows read-only ordering anchors", () => {
    const moved = row("moved", { activeOrderKey: "t" });
    const oldServer = row("first", { environmentId: remote });
    const canReorder: Input["canReorder"] = (environmentId) => environmentId === local;
    expect(plan([oldServer, moved], moved, { canReorder })).toMatchObject({
      assignments: [],
      disabledReason: expect.stringContaining("Update the servers"),
    });
    expect(
      plan([{ ...oldServer, activeOrderKey: "f" }, moved], moved, { canReorder })?.assignments,
    ).toHaveLength(1);
    expect(plan([oldServer, moved], oldServer, { canReorder })).toBeNull();
  });
});
