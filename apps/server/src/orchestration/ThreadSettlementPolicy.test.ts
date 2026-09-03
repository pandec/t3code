import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { resolveAutoSettlementAt } from "./ThreadSettlementPolicy.ts";

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
  pullRequest: { state: "open" | "closed" | "merged"; updatedAt: string | null } | null = null,
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
        pullRequest: { state: "closed", updatedAt: NOW },
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
        { state: "closed", updatedAt: NOW },
        { enabled: false, days: null },
      ),
    ).toBeNull();
  });

  it("keeps indefinitely snoozed threads out of automatic settlement", () => {
    const thread = makeThread({ snoozedAt: LAST_ACTIVITY_AT, snoozedUntil: null });
    expect(settlementAt(thread)).toBeNull();
    expect(settlementAt(thread, { state: "closed", updatedAt: NOW }, { days: null })).toBeNull();
  });

  it("keeps a thread active at the exact inactivity boundary", () => {
    expect(
      settlementAt(makeThread({ latestUserMessageAt: "2026-08-25T12:00:00.000Z" })),
    ).toBeNull();
  });

  it("keeps open pull requests active", () => {
    expect(settlementAt(makeThread(), { state: "open", updatedAt: NOW })).toBeNull();
  });

  it("settles closed requests and honors the merge setting", () => {
    expect(settlementAt(makeThread(), { state: "closed", updatedAt: NOW }, { merge: false })).toBe(
      LAST_ACTIVITY_AT,
    );
    expect(settlementAt(makeThread(), { state: "merged", updatedAt: NOW }, { merge: false })).toBe(
      LAST_ACTIVITY_AT,
    );
    expect(
      settlementAt(makeThread(), { state: "merged", updatedAt: NOW }, { merge: false, days: null }),
    ).toBeNull();
  });

  it("does not settle again after user activity newer than the PR", () => {
    expect(
      settlementAt(
        makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" }),
        { state: "merged", updatedAt: "2026-08-26T00:00:00.000Z" },
        { days: null },
      ),
    ).toBeNull();
  });

  it("does not inherit a terminal pull request older than the thread", () => {
    expect(
      settlementAt(
        makeThread({ createdAt: LAST_ACTIVITY_AT, latestUserMessageAt: null }),
        { state: "closed", updatedAt: "2026-08-19T00:00:00.000Z" },
        { days: null },
      ),
    ).toBeNull();
  });

  it("requires a comparable PR timestamp for immediate settlement", () => {
    const recentThread = makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" });
    expect(settlementAt(recentThread, { state: "closed", updatedAt: null })).toBeNull();
    expect(settlementAt(recentThread, { state: "merged", updatedAt: "unknown" })).toBeNull();
    expect(settlementAt(makeThread(), { state: "closed", updatedAt: null })).toBe(LAST_ACTIVITY_AT);
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
    expect(settlementAt(thread, { state: "merged", updatedAt: "2026-08-26T00:00:00.000Z" })).toBe(
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
