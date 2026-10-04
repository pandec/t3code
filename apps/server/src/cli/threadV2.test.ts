import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2DispatchCommandError,
  CommandId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { RpcClientError } from "effect/unstable/rpc";

import { serializeCliError } from "./errorOutput.ts";
import { makeTestThreadShell, testShellTime } from "./liveServerTestKit.ts";
import {
  launchedThreadIsReportable,
  liveRpcCommandError,
  liveServerWebSocketUrl,
} from "./orchestrationRpc.ts";
import {
  createdThreadWorkspace,
  findThread,
  threadContextEnvironment,
  threadSnoozeText,
  threadSummary,
} from "./thread.ts";
import { threadCliState } from "./threadState.ts";

const threadId = ThreadId.make("thread-v2-cli");
const runId = RunId.make("run-v2-cli");

describe("thread CLI on orchestration v2", () => {
  it("folds v2 run statuses into the CLI turn states", () => {
    const state = (status: Parameters<typeof threadCliState>[0]["status"]) =>
      threadCliState({ status, activeRunId: null });
    assert.deepEqual(
      [
        state("idle"),
        state("queued"),
        state("waiting"),
        state("completed"),
        state("rolled_back"),
        state("cancelled"),
        state("interrupted"),
        state("failed"),
      ],
      [
        "idle",
        "running",
        "running",
        "completed",
        "completed",
        "interrupted",
        "interrupted",
        "error",
      ],
    );
    // An active run wins over a stale terminal status.
    assert.strictEqual(threadCliState({ status: "completed", activeRunId: runId }), "running");
  });

  it("keeps the fork summary keys, filled from run-based v2 fields", () => {
    const summary = threadSummary(
      makeTestThreadShell(threadId, {
        activeRunId: runId,
        latestRunId: runId,
        status: "running",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-1"),
          kind: "user_input",
          createdAt: testShellTime,
        },
        pendingBackgroundTasks: [{ taskId: "task-1", kind: "monitor" }],
        snoozedAt: testShellTime,
        snoozedUntil: null,
        snoozedUntilRunId: runId,
        settledOverride: "settled",
        settledAt: testShellTime,
      }),
    );
    assert.deepEqual(
      {
        state: summary.state,
        activeTurnId: summary.activeTurnId,
        backgroundLiveness: summary.backgroundLiveness,
        snoozedAt: summary.snoozedAt,
        snoozedUntilTurnId: summary.snoozedUntilTurnId,
        settled: summary.settled,
        hasPendingApprovals: summary.hasPendingApprovals,
        hasPendingUserInput: summary.hasPendingUserInput,
        hasPendingBlockingUserInput: summary.hasPendingBlockingUserInput,
      },
      {
        state: "running",
        activeTurnId: runId,
        backgroundLiveness: "monitoring",
        snoozedAt: "2026-10-04T10:00:00.000Z",
        snoozedUntilTurnId: runId,
        settled: true,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
        hasPendingBlockingUserInput: true,
      },
    );
  });

  it("reports what the clients show for each snooze mode", () => {
    const now = "2026-10-04T12:00:00.000Z";
    const later = DateTime.makeUnsafe("2026-10-05T06:00:00.000Z");
    assert.strictEqual(
      threadSnoozeText(
        makeTestThreadShell(threadId, { snoozedAt: testShellTime, snoozedUntil: later }),
        now,
      ),
      "until 2026-10-05T06:00:00.000Z",
    );
    assert.strictEqual(
      threadSnoozeText(makeTestThreadShell(threadId, { snoozedAt: testShellTime }), now),
      "until woken",
    );
    // A timer that already passed is a derived wake; the fields stay set.
    assert.strictEqual(
      threadSnoozeText(
        makeTestThreadShell(threadId, { snoozedAt: testShellTime, snoozedUntil: testShellTime }),
        now,
      ),
      "no",
    );
  });

  it("resolves self from T3CODE_THREAD_ID and fails closed without it", () => {
    const threads = [makeTestThreadShell(threadId)];
    const previous = process.env.T3CODE_THREAD_ID;
    try {
      process.env.T3CODE_THREAD_ID = ` ${threadId} `;
      assert.strictEqual(findThread(threads, "self")?.id, threadId);
      delete process.env.T3CODE_THREAD_ID;
      assert.isUndefined(findThread(threads, "self"));
      assert.strictEqual(findThread(threads, ` ${threadId}`)?.id, threadId);
    } finally {
      if (previous === undefined) delete process.env.T3CODE_THREAD_ID;
      else process.env.T3CODE_THREAD_ID = previous;
    }
  });

  it("exports the run as the turn id and falls back to the project root", () => {
    assert.deepEqual(
      threadContextEnvironment(makeTestThreadShell(threadId, { activeRunId: runId }), "/repo"),
      { T3CODE_THREAD_ID: threadId, T3CODE_TURN_ID: runId, T3CODE_WORKTREE_PATH: "/repo" },
    );
  });

  it("separates declared rejections from unknown outcomes", () => {
    const rejected = serializeCliError(
      liveRpcCommandError("thread.pin")(
        new OrchestrationV2DispatchCommandError({
          commandId: CommandId.make("command-1"),
          commandType: "thread.pin",
          message: "Failed to dispatch orchestration V2 command",
          detail: "Thread was deleted.",
        }),
      ),
    );
    assert.deepEqual(
      { code: rejected.code, message: rejected.message, outcome: rejected.outcome },
      {
        code: "CliOrchestrationCommandRejectedError",
        message: "Thread was deleted.",
        outcome: undefined,
      },
    );
    const lost = serializeCliError(
      liveRpcCommandError("thread.pin")(
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({ message: "socket closed", cause: null }),
        }),
      ),
    );
    assert.deepEqual(
      { code: lost.code, outcome: lost.outcome },
      { code: "CliOrchestrationOutcomeUnknownError", outcome: "unknown" },
    );
  });

  it("targets the protocol-2 socket with the issued ticket", () => {
    const url = new URL(liveServerWebSocketUrl("https://host.test:8443", "ticket+1"));
    assert.deepEqual(
      [
        url.protocol,
        url.pathname,
        url.searchParams.get("orchestrationProtocol"),
        url.searchParams.get("wsTicket"),
      ],
      ["wss:", "/ws", "2", "ticket+1"],
    );
  });

  it("waits for a new worktree's path unless preparation ended", () => {
    const preparing = makeTestThreadShell(threadId, { status: "preparing" });
    assert.isTrue(launchedThreadIsReportable(preparing, { awaitWorktree: false }));
    assert.isFalse(launchedThreadIsReportable(preparing, { awaitWorktree: true }));
    assert.isTrue(
      launchedThreadIsReportable(
        makeTestThreadShell(threadId, { status: "preparing", worktreePath: "/repo-wt" }),
        { awaitWorktree: true },
      ),
    );
    assert.isTrue(
      launchedThreadIsReportable(makeTestThreadShell(threadId, { status: "failed" }), {
        awaitWorktree: true,
      }),
    );
  });

  it("reports a Scratch root launch's own folder as scratch", () => {
    assert.deepEqual(
      createdThreadWorkspace("checkout", { branch: null, worktreePath: "/scratch/thread" }),
      { mode: "scratch", branch: null, worktreePath: "/scratch/thread" },
    );
    assert.strictEqual(
      createdThreadWorkspace("checkout", { branch: "main", worktreePath: null }).mode,
      "checkout",
    );
  });
});
