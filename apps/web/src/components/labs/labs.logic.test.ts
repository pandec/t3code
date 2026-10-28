import type { LabEnvironment, LabRuntime } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_DRAFT_LAB_INTENT, normalizeDraftLabIntent } from "../../composerDraftStore";
import {
  countFreeLabs,
  findLabForThread,
  isLabHeldByArchivedThread,
  isLabIdleHold,
  orderLabEnvironments,
  releaseCanStopFirst,
  resolveLabAvailability,
  resolveLabBranchRequest,
  resolveLabSendTarget,
  resolveLabStackHealth,
  shouldDefaultToLabMode,
  summarizeLabEnvironment,
  summarizeLabsAttention,
  type LabOwnerView,
  type LabSummary,
} from "./labs.logic";

const stoppedRuntime: LabRuntime = {
  checkedAt: "2026-10-14T10:00:00.000Z",
  chrome: { state: "down", detail: "" },
  wxt: { state: "down", detail: "" },
  backend: { state: "unknown", detail: "" },
  extension: { state: "unverified", detail: "" },
  git: { branch: "master", commit: "abc1234", dirty: false },
  session: false,
  diagnosis: [],
  operation: null,
};

const runningRuntime: LabRuntime = {
  ...stoppedRuntime,
  chrome: { state: "up", detail: "" },
  wxt: { state: "up", detail: "" },
  backend: { state: "ready", detail: "" },
  session: true,
};

function lab(id: string, overrides: Partial<LabEnvironment> = {}): LabEnvironment {
  return {
    id,
    name: id,
    kind: "lab",
    labKind: "full",
    lender: null,
    phase: "ready",
    available: true,
    worktree: `/repos/${id}`,
    cdpPort: 9311,
    wxtPort: 3111,
    lease: null,
    hold: null,
    handoff: null,
    recentLeases: [],
    runtime: stoppedRuntime,
    lastActivityAt: null,
    ...overrides,
  };
}

const lease = (labId: string, threadId: string) => ({
  id: `lease-${labId}`,
  labId,
  threadId,
  purpose: "work",
  acquiredAt: "2026-10-14T09:00:00.000Z",
});

describe("lab draft intent", () => {
  it("accepts a well-formed intent and drops malformed ones", () => {
    expect(normalizeDraftLabIntent(DEFAULT_DRAFT_LAB_INTENT)).toEqual(DEFAULT_DRAFT_LAB_INTENT);
    expect(normalizeDraftLabIntent({ ...DEFAULT_DRAFT_LAB_INTENT, branchMode: "rebase" })).toBe(
      null,
    );
    expect(normalizeDraftLabIntent({ labId: "sp-lab-1" })).toBe(null);
    expect(normalizeDraftLabIntent(undefined)).toBe(null);
  });

  it("asks for an automatic name when creating without one, from master by default", () => {
    expect(resolveLabBranchRequest({ ...DEFAULT_DRAFT_LAB_INTENT, baseRef: " " })).toEqual({
      ok: true,
      branch: null,
      baseRef: "master",
    });
    expect(
      resolveLabBranchRequest({
        ...DEFAULT_DRAFT_LAB_INTENT,
        branchName: " fix/picklist ",
        baseRef: "develop",
      }),
    ).toEqual({ ok: true, branch: "fix/picklist", baseRef: "develop" });
  });

  it("continues an existing branch without a base and requires its name", () => {
    expect(
      resolveLabBranchRequest({
        ...DEFAULT_DRAFT_LAB_INTENT,
        branchMode: "continue",
        branchName: "design/cosmos",
      }),
    ).toEqual({ ok: true, branch: "design/cosmos", baseRef: null });
    expect(
      resolveLabBranchRequest({ ...DEFAULT_DRAFT_LAB_INTENT, branchMode: "continue" }).ok,
    ).toBe(false);
  });
});

describe("lab send target", () => {
  const snapshot = {
    environments: [
      lab("sp-lab-1", { lease: lease("sp-lab-1", "other"), available: false }),
      lab("sp-lab-2", {
        hold: { labId: "sp-lab-2", note: "excel", heldAt: "" },
        available: false,
      }),
      lab("sp-lab-3"),
      lab("sp-lab-6", { labKind: "lite", lender: "sp-lab-1" }),
    ],
  };

  it("falls back to the first free lab of the draft's kind, lite by default", () => {
    expect(resolveLabSendTarget(DEFAULT_DRAFT_LAB_INTENT, snapshot, "thread-1")).toEqual({
      ok: true,
      labId: "sp-lab-6",
    });
    const full = { ...DEFAULT_DRAFT_LAB_INTENT, labKind: "full" as const };
    expect(resolveLabSendTarget(full, snapshot, "thread-1")).toEqual({
      ok: true,
      labId: "sp-lab-3",
    });
    // Drafts saved before lite labs carry no kind.
    const { labKind: _labKind, ...legacy } = DEFAULT_DRAFT_LAB_INTENT;
    expect(normalizeDraftLabIntent(legacy)).toEqual(legacy);
    expect(resolveLabSendTarget(legacy, snapshot, "thread-1")).toEqual({
      ok: true,
      labId: "sp-lab-6",
    });
    expect(
      resolveLabSendTarget(full, { environments: snapshot.environments.slice(0, 2) }, "t"),
    ).toEqual({ ok: false, error: "No full lab is free. Release one in the Labs panel." });
  });

  it("refuses a pick that another thread reserved or the human holds", () => {
    const pick = (labId: string) => ({ ...DEFAULT_DRAFT_LAB_INTENT, labId });
    expect(resolveLabSendTarget(pick("sp-lab-1"), snapshot, "thread-1").ok).toBe(false);
    expect(resolveLabSendTarget(pick("sp-lab-2"), snapshot, "thread-1").ok).toBe(false);
    // Quarantined, unknown, or not loaded yet: fail before the send, not in the CLI.
    const quarantined = {
      environments: [lab("sp-lab-4", { phase: "quarantined", available: false })],
    };
    expect(resolveLabSendTarget(pick("sp-lab-4"), quarantined, "thread-1").ok).toBe(false);
    expect(resolveLabSendTarget(pick("sp-lab-9"), snapshot, "thread-1").ok).toBe(false);
    expect(resolveLabSendTarget(pick("sp-lab-3"), null, "thread-1").ok).toBe(false);
    expect(resolveLabSendTarget(pick("sp-lab-3"), snapshot, "thread-1")).toEqual({
      ok: true,
      labId: "sp-lab-3",
    });
    // A retried send finds the lab already reserved for this thread, whatever the pick.
    expect(resolveLabSendTarget(DEFAULT_DRAFT_LAB_INTENT, snapshot, "other")).toEqual({
      ok: true,
      labId: "sp-lab-1",
    });
  });

  it("reports when no lab is free or labs have not loaded", () => {
    expect(resolveLabSendTarget(DEFAULT_DRAFT_LAB_INTENT, { environments: [] }, "t").ok).toBe(
      false,
    );
    expect(resolveLabSendTarget(DEFAULT_DRAFT_LAB_INTENT, null, "t").ok).toBe(false);
  });
});

describe("lab classification", () => {
  it("prefers a reservation over a hold", () => {
    expect(
      resolveLabAvailability(
        lab("a", {
          lease: lease("a", "t"),
          hold: { labId: "a", note: "", heldAt: "" },
          available: false,
        }),
      ),
    ).toBe("reserved");
    expect(resolveLabAvailability(lab("b", { phase: "quarantined", available: false }))).toBe(
      "unavailable",
    );
  });

  it("matches lab threads by worktree path, then by lease owner", () => {
    const environments = [
      { ...lab("sp-lab-1"), ownerThreadId: null },
      { ...lab("sp-lab-2"), worktree: "/repos/sp-lab-2", ownerThreadId: "mcp:t2" },
      {
        ...lab("staging"),
        kind: "staging" as const,
        worktree: "/repos/salespros",
        ownerThreadId: "t9",
      },
    ];
    const find = (threadId: string, worktreePath: string | null) =>
      findLabForThread(environments, { threadId, worktreePath })?.id ?? null;
    expect(find("t1", "/repos/sp-lab-1/")).toBe("sp-lab-1");
    expect(find("t1", "/repos/sp-lab-10")).toBe(null);
    expect(find("mcp:t2", "/t3/worktrees/salespros/feature")).toBe("sp-lab-2");
    expect(find("t9", "/repos/salespros")).toBe(null);
    expect(find("t1", null)).toBe(null);
  });

  it("defaults to Lab mode only in the labs project, while SP Labs is on", () => {
    const base = { defaultToLabMode: true, configured: true, labsProjectId: "p1" };
    expect(shouldDefaultToLabMode({ ...base, projectId: "p1" })).toBe(true);
    expect(shouldDefaultToLabMode({ ...base, projectId: "p2" })).toBe(false);
    expect(shouldDefaultToLabMode({ ...base, labsProjectId: null, projectId: null })).toBe(false);
    expect(shouldDefaultToLabMode({ ...base, configured: false, projectId: "p1" })).toBe(false);
    expect(shouldDefaultToLabMode({ ...base, defaultToLabMode: false, projectId: "p1" })).toBe(
      false,
    );
  });
});

describe("lab stack health", () => {
  it("shows a running operation first, then a failed start", () => {
    expect(resolveLabStackHealth(lab("a"), { operation: "starting", lastUp: null }).tone).toBe(
      "busy",
    );
    expect(
      resolveLabStackHealth(lab("a"), {
        operation: null,
        lastUp: { ok: false, detail: "extension", at: "" },
      }),
    ).toEqual({ tone: "error", label: "Start failed" });
  });

  it("reads passive health when T3 is idle", () => {
    expect(resolveLabStackHealth(lab("a", { runtime: runningRuntime }), undefined).tone).toBe("ok");
    expect(resolveLabStackHealth(lab("a"), undefined).tone).toBe("off");
    expect(
      resolveLabStackHealth(
        lab("a", { runtime: { ...stoppedRuntime, chrome: { state: "up", detail: "" } } }),
        undefined,
      ).tone,
    ).toBe("warn");
  });
});

describe("release blockers", () => {
  it("offers stop-first only when a running stack is the sole blocker", () => {
    const running = { kind: "stack_running" as const, detail: "" };
    const dirty = { kind: "dirty_worktree" as const, detail: "2 files" };
    expect(releaseCanStopFirst([running])).toBe(true);
    expect(releaseCanStopFirst([running, dirty])).toBe(false);
    expect(releaseCanStopFirst([])).toBe(false);
  });
});

describe("dashboard summaries", () => {
  const now = Date.parse("2026-10-14T12:00:00.000Z");
  const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const owner = (overrides: Partial<LabOwnerView> = {}): LabOwnerView => ({
    title: "Fix picklists",
    working: false,
    needsYou: false,
    archived: false,
    lastActivityAt: hoursAgo(1),
    ...overrides,
  });
  const reserved = (acquiredHoursAgo: number, lastActivityAt: string | null = null) =>
    lab("sp-lab-2", {
      available: false,
      lease: { ...lease("sp-lab-2", "t"), acquiredAt: hoursAgo(acquiredHoursAgo) },
      lastActivityAt,
    });

  it("phrases a held reservation and a free lab like the dashboard", () => {
    expect(summarizeLabEnvironment(reserved(3), owner(), now)).toMatchObject({
      word: "Reserved",
      tone: "reserved",
      sentence: [{ owner: "Fix picklists" }, " holds it, taken 3 h ago."],
    });
    const free = lab("sp-lab-3", {
      handoff: {
        summary: "Stripe clock advanced",
        branch: "t3/x",
        commit: "abc",
        disposition: "usable",
        threadId: null,
        releasedAt: hoursAgo(0.75),
      },
    });
    expect(summarizeLabEnvironment(free, null, now)).toMatchObject({
      word: "Free",
      sentence: ["Released 45 min ago, left usable."],
      note: "Stripe clock advanced",
    });
  });

  it("flags a reservation held by an archived thread as bad, even while it looks idle", () => {
    const archived = owner({ archived: true, lastActivityAt: hoursAgo(23) });
    expect(isLabHeldByArchivedThread(reserved(30), archived)).toBe(true);
    expect(isLabHeldByArchivedThread(reserved(30), owner())).toBe(false);
    expect(summarizeLabEnvironment(reserved(30, hoursAgo(23)), archived, now)).toMatchObject({
      tone: "bad",
      sentence: [{ owner: "Fix picklists" }, " was archived but still holds this lab."],
      needsLook: true,
    });
  });

  it("calls a quiet reservation an idle hold after 18 h, never while the owner works", () => {
    const quiet = owner({ lastActivityAt: hoursAgo(23) });
    expect(isLabIdleHold(reserved(30, hoursAgo(23)), quiet, now)).toBe(true);
    expect(isLabIdleHold(reserved(30, hoursAgo(23)), { ...quiet, working: true }, now)).toBe(false);
    // Recent lab activity keeps a quiet thread's reservation live.
    expect(isLabIdleHold(reserved(30, hoursAgo(2)), quiet, now)).toBe(false);
    expect(summarizeLabEnvironment(reserved(30, hoursAgo(23)), quiet, now)).toMatchObject({
      word: "Idle hold",
      sentence: [{ owner: "Fix picklists" }, " finished 23 h ago but still holds the lab."],
      needsLook: true,
    });
  });

  it("counts free labs and names what needs a look", () => {
    const summary = (word: string, tone: LabSummary["tone"], needsLook = false) => ({
      word,
      tone,
      sentence: [],
      note: null,
      since: null,
      needsLook,
    });
    const labs = [
      { name: "sp-lab-1", summary: summary("Reserved", "reserved") },
      { name: "sp-lab-2", summary: summary("Idle hold", "attention", true) },
      { name: "sp-lab-3", summary: summary("Free", "free") },
    ];
    expect(countFreeLabs(labs.map((lab) => lab.summary))).toBe("1 of 3 free");
    expect(summarizeLabsAttention(labs)).toBe("sp-lab-2 needs a look.");
    expect(summarizeLabsAttention([{ name: "a", summary: summary("Free", "free") }])).toBe(null);
  });

  it("lists full then lite labs in numeric order before the shared checkouts", () => {
    const ordered = orderLabEnvironments([
      { kind: "staging" as const, labKind: null, name: "Main / Staging" },
      { kind: "lab" as const, labKind: "lite" as const, name: "sp-lab-10" },
      { kind: "lab" as const, labKind: "lite" as const, name: "sp-lab-6" },
      { kind: "lab" as const, labKind: "full" as const, name: "sp-lab-2" },
      // An sp-labs checkout from before lite labs reports no kind: full.
      { kind: "lab" as const, labKind: null, name: "sp-lab-1" },
      { kind: "preview" as const, labKind: null, name: "Preview" },
    ]);
    expect(
      ordered.groups.map((group) => [group.kind, group.labs.map((entry) => entry.name)]),
    ).toEqual([
      ["full", ["sp-lab-1", "sp-lab-2"]],
      ["lite", ["sp-lab-6", "sp-lab-10"]],
    ]);
    expect(ordered.shared.map((entry) => entry.name)).toEqual(["Main / Staging", "Preview"]);
  });
});
