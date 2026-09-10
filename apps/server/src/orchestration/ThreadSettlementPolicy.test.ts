import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  TurnId,
  type OrchestrationThreadShell,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  type SettlementPullRequest,
  isThreadSnoozed,
  resolveAutoSettlementAt,
} from "./ThreadSettlementPolicy.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const LAST_ACTIVITY_AT = "2026-08-20T00:00:00.000Z";
const makeThread = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  pullRequests: [],
  branch: "feature",
  worktreePath: "/repo",
  latestTurn: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: LAST_ACTIVITY_AT,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: LAST_ACTIVITY_AT,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const settlementAt = (
  thread: OrchestrationThreadShell,
  pullRequest: SettlementPullRequest | null = null,
  settings: { enabled?: boolean; days?: number | null; merge?: boolean } = {},
) =>
  resolveAutoSettlementAt({
    thread,
    pullRequest,
    now: NOW,
    threadAutoSettleEnabled: settings.enabled ?? true,
    autoSettleAfterDays: settings.days === undefined ? 3 : settings.days,
    autoSettleOnMerge: settings.merge ?? true,
  });

// Upstream's boolean helper; rides the fork's settings shape so the master gate is part of it.
const decide = (
  thread: OrchestrationThreadShell,
  pullRequest: SettlementPullRequest | null = null,
  settings: { enabled?: boolean; days?: number | null; merge?: boolean } = {},
) => settlementAt(thread, pullRequest, settings) !== null;

describe("resolveAutoSettlementAt", () => {
  it("returns the last activity time for persisted settlement", () => {
    expect(
      resolveAutoSettlementAt({
        thread: makeThread({
          latestTurn: {
            turnId: TurnId.make("turn-terminal"),
            state: "completed",
            requestedAt: "2026-08-19T00:00:00.000Z",
            startedAt: "2026-08-19T00:01:00.000Z",
            completedAt: "2026-08-21T00:00:00.000Z",
            assistantMessageId: null,
          },
        }),
        pullRequest: null,
        now: NOW,
        threadAutoSettleEnabled: true,
        autoSettleAfterDays: 3,
        autoSettleOnMerge: true,
      }),
    ).toBe("2026-08-21T00:00:00.000Z");
  });

  it("uses creation time for PR settlement when the thread has no activity", () => {
    expect(
      resolveAutoSettlementAt({
        thread: makeThread({
          latestUserMessageAt: null,
          latestTurn: null,
          updatedAt: "2026-08-27T00:00:00.000Z",
        }),
        pullRequest: { state: "closed", closedAt: NOW },
        now: NOW,
        threadAutoSettleEnabled: true,
        autoSettleAfterDays: null,
        autoSettleOnMerge: true,
      }),
    ).toBe("2026-08-01T00:00:00.000Z");
  });

  it("settles inactive threads and leaves never-used threads active", () => {
    expect(settlementAt(makeThread())).toBe(LAST_ACTIVITY_AT);
    expect(settlementAt(makeThread({ latestUserMessageAt: null }))).toBeNull();
    expect(settlementAt(makeThread(), null, { days: null })).toBeNull();
  });

  it("disables every automatic settlement reason behind the master gate", () => {
    expect(settlementAt(makeThread(), null, { enabled: false })).toBeNull();
    expect(
      settlementAt(
        makeThread(),
        { state: "closed", closedAt: NOW },
        { enabled: false, days: null },
      ),
    ).toBeNull();
  });

  it("keeps indefinitely snoozed threads out of automatic settlement", () => {
    const thread = makeThread({ snoozedAt: LAST_ACTIVITY_AT, snoozedUntil: null });
    expect(settlementAt(thread)).toBeNull();
    expect(settlementAt(thread, { state: "closed", closedAt: NOW }, { days: null })).toBeNull();
  });

  it("keeps a thread active at the exact inactivity boundary", () => {
    expect(
      settlementAt(makeThread({ latestUserMessageAt: "2026-08-25T12:00:00.000Z" })),
    ).toBeNull();
  });

  it("settles inactive threads with open pull requests", () => {
    expect(settlementAt(makeThread(), { state: "open", updatedAt: NOW })).toBe(LAST_ACTIVITY_AT);
  });

  it("settles closed requests and honors the merge setting", () => {
    expect(settlementAt(makeThread(), { state: "closed", closedAt: NOW }, { merge: false })).toBe(
      LAST_ACTIVITY_AT,
    );
    expect(settlementAt(makeThread(), { state: "merged", mergedAt: NOW }, { merge: false })).toBe(
      LAST_ACTIVITY_AT,
    );
    expect(
      settlementAt(makeThread(), { state: "merged", mergedAt: NOW }, { merge: false, days: null }),
    ).toBeNull();
  });

  it("does not settle again after user activity newer than the PR", () => {
    expect(
      settlementAt(
        makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" }),
        { state: "merged", mergedAt: "2026-08-26T00:00:00.000Z" },
        { days: null },
      ),
    ).toBeNull();
  });

  it.each(["closed", "merged"] as const)(
    "ignores metadata edits after resumed work for %s requests",
    (state) => {
      expect(
        settlementAt(
          makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" }),
          {
            state,
            closedAt: "2026-08-26T00:00:00.000Z",
            mergedAt: "2026-08-26T00:00:00.000Z",
            updatedAt: NOW,
          },
          { days: null },
        ),
      ).toBeNull();
      expect(settlementAt(makeThread(), { state, updatedAt: NOW }, { days: null })).toBeNull();
    },
  );

  it("does not inherit a terminal pull request older than the thread", () => {
    expect(
      settlementAt(
        makeThread({ createdAt: LAST_ACTIVITY_AT, latestUserMessageAt: null }),
        { state: "closed", closedAt: "2026-08-19T00:00:00.000Z" },
        { days: null },
      ),
    ).toBeNull();
  });

  it("requires a comparable PR timestamp for immediate settlement", () => {
    const recentThread = makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" });
    expect(settlementAt(recentThread, { state: "closed", closedAt: null })).toBeNull();
    expect(settlementAt(recentThread, { state: "merged", mergedAt: "unknown" })).toBeNull();
    expect(settlementAt(makeThread(), { state: "closed", closedAt: null })).toBe(LAST_ACTIVITY_AT);
  });

  it("uses user request time instead of completion time as the PR anchor", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-25T00:00:00.000Z",
        startedAt: "2026-08-25T00:01:00.000Z",
        completedAt: "2026-08-27T00:00:00.000Z",
        assistantMessageId: null,
      },
    });
    expect(settlementAt(thread, { state: "merged", mergedAt: "2026-08-26T00:00:00.000Z" })).toBe(
      "2026-08-27T00:00:00.000Z",
    );
  });

  it("blocks pins, snooze, pending work, live sessions, and queued starts", () => {
    expect(settlementAt(makeThread({ settledOverride: "active" }))).toBeNull();
    expect(settlementAt(makeThread({ snoozedUntil: "2026-08-29T00:00:00.000Z" }))).toBeNull();
    expect(settlementAt(makeThread({ hasPendingApprovals: true }))).toBeNull();
    expect(settlementAt(makeThread({ hasPendingUserInput: true }))).toBeNull();
    expect(settlementAt(makeThread({ backgroundLiveness: "working" }))).toBeNull();
    expect(settlementAt(makeThread({ backgroundLiveness: "monitoring" }))).toBeNull();
    expect(
      settlementAt(
        makeThread({
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: NOW,
          },
        }),
      ),
    ).toBeNull();
    expect(
      settlementAt(
        makeThread({ latestUserMessageAt: "2026-08-28T11:59:00.000Z", latestTurn: null }),
      ),
    ).toBeNull();
  });

  it("keeps an until-done snooze out of settlement only while its turn runs", () => {
    const untilDone = {
      snoozedAt: "2026-08-19T00:00:00.000Z",
      snoozedUntilTurnId: TurnId.make("turn-done"),
    };
    expect(
      settlementAt(
        makeThread({
          ...untilDone,
          latestTurn: {
            turnId: TurnId.make("turn-done"),
            state: "running",
            requestedAt: "2026-08-18T00:00:00.000Z",
            startedAt: "2026-08-18T00:01:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      ),
    ).toBeNull();
    expect(
      settlementAt(
        makeThread({
          ...untilDone,
          latestTurn: {
            turnId: TurnId.make("turn-done"),
            state: "interrupted",
            requestedAt: "2026-08-18T00:00:00.000Z",
            startedAt: "2026-08-18T00:01:00.000Z",
            completedAt: LAST_ACTIVITY_AT,
            assistantMessageId: null,
          },
        }),
      ),
    ).toBe(LAST_ACTIVITY_AT);
    // The awaited turn was replaced by a newer running one, or vanished:
    // awake either way. (Settlement itself still waits for the live
    // session / completion rules, so assert the classification directly.)
    expect(
      isThreadSnoozed(
        makeThread({
          ...untilDone,
          latestTurn: {
            turnId: TurnId.make("turn-next"),
            state: "running",
            requestedAt: "2026-08-21T00:00:00.000Z",
            startedAt: "2026-08-21T00:01:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        }),
        NOW,
      ),
    ).toBe(false);
    expect(isThreadSnoozed(makeThread({ ...untilDone, latestTurn: null }), NOW)).toBe(false);
  });

  it("allows a fresh completion to wake snooze before settlement", () => {
    expect(
      settlementAt(
        makeThread({
          snoozedAt: "2026-08-19T00:00:00.000Z",
          snoozedUntil: "2026-08-29T00:00:00.000Z",
          latestTurn: {
            turnId: TurnId.make("turn-woke"),
            state: "completed",
            requestedAt: "2026-08-18T00:00:00.000Z",
            startedAt: "2026-08-18T00:01:00.000Z",
            completedAt: LAST_ACTIVITY_AT,
            assistantMessageId: null,
          },
        }),
      ),
    ).toBe(LAST_ACTIVITY_AT);
  });
});

function linkedRequest(
  number: number,
  snapshot: ThreadPullRequestLink["snapshot"],
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "org/repo",
    number,
    url: `https://github.com/org/repo/pull/${number}`,
    source: "manual",
    linkedAt: NOW,
    stack: null,
    snapshot,
  };
}

const terminalSnapshot = (
  state: "closed" | "merged",
  terminalAt: string,
  updatedAt = terminalAt,
) => ({
  state,
  title: "Change",
  headBranch: "feature",
  baseBranch: "main",
  isDraft: false,
  closedAt: terminalAt,
  mergedAt: state === "merged" ? terminalAt : null,
  updatedAt,
  syncedAt: NOW,
});

describe("linked request settlement", () => {
  it.each(["closed", "merged"] as const)(
    "uses the latest actual %s transition despite later comments on another PR",
    (state) => {
      const old = linkedRequest(1, terminalSnapshot(state, "2026-08-19T00:00:00.000Z", NOW));
      const recent = linkedRequest(2, terminalSnapshot(state, "2026-08-21T00:00:00.000Z"));
      expect(decide(makeThread({ pullRequests: [old, recent] }), null, { days: null })).toBe(true);
      expect(decide(makeThread({ pullRequests: [recent, old] }), null, { days: null })).toBe(true);
      expect(decide(makeThread({ pullRequests: [old] }), null, { days: null })).toBe(false);
    },
  );

  it("keeps unknown and open links active even after the inactivity window", () => {
    const merged = linkedRequest(1, terminalSnapshot("merged", NOW));
    const unknown = linkedRequest(2, null);
    const open = linkedRequest(3, {
      ...terminalSnapshot("closed", NOW),
      state: "open",
      closedAt: null,
    });
    expect(decide(makeThread({ pullRequests: [merged, unknown] }))).toBe(false);
    expect(decide(makeThread({ pullRequests: [merged, open] }))).toBe(false);
    expect(
      decide(makeThread({ pullRequests: [merged, { ...unknown, source: "stack-dismissed" }] })),
    ).toBe(true);
  });

  it("honors merge settings and ignores missing terminal timestamps", () => {
    const merged = linkedRequest(1, terminalSnapshot("merged", NOW));
    expect(decide(makeThread({ pullRequests: [merged] }), null, { days: null, merge: false })).toBe(
      false,
    );
    const missing = linkedRequest(2, { ...terminalSnapshot("merged", NOW), mergedAt: null });
    expect(decide(makeThread({ pullRequests: [missing] }), null, { days: null })).toBe(false);
    expect(decide(makeThread({ pullRequests: [missing, merged] }), null, { days: null })).toBe(
      true,
    );
  });
});
