import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { threadCliState, threadHasActiveTurn, threadIsQuiescent } from "./threadState.ts";

const NOW = "2026-08-08T12:00:00.000Z";

const threadWith = (input: Partial<OrchestrationThreadShell>): OrchestrationThreadShell =>
  ({
    latestUserMessageAt: null,
    latestTurn: null,
    session: null,
    ...input,
  }) as OrchestrationThreadShell;

it("uses error precedence when a stale latest turn still looks running", () => {
  const thread = threadWith({
    session: { status: "error", activeTurnId: "turn-1" } as OrchestrationThreadShell["session"],
    latestTurn: { state: "running" } as OrchestrationThreadShell["latestTurn"],
  });

  assert.equal(threadCliState(thread), "error");
  assert.isFalse(threadHasActiveTurn(thread));
});

it("presents session startup as running without claiming an interruptible turn", () => {
  const thread = threadWith({
    session: { status: "starting", activeTurnId: null } as OrchestrationThreadShell["session"],
  });

  assert.equal(threadCliState(thread), "running");
  assert.isFalse(threadHasActiveTurn(thread));
  assert.deepEqual(threadIsQuiescent(thread, { now: NOW }), { quiescent: false });
});

it("requires evidence of an active turn before allowing interruption", () => {
  const transitional = threadWith({
    session: { status: "running", activeTurnId: null } as OrchestrationThreadShell["session"],
  });
  const active = threadWith({
    session: {
      status: "running",
      activeTurnId: "turn-1",
    } as OrchestrationThreadShell["session"],
  });

  assert.isFalse(threadHasActiveTurn(transitional));
  assert.isTrue(threadHasActiveTurn(active));
});

it("keeps a freshly queued turn start non-quiescent", () => {
  const thread = threadWith({ latestUserMessageAt: "2026-08-08T11:59:30.000Z" });

  assert.deepEqual(threadIsQuiescent(thread, { now: NOW }), { quiescent: false });
});

it("detects a fresh queued start after every timestamp on the prior turn", () => {
  const thread = threadWith({
    latestUserMessageAt: "2026-08-08T11:59:30.000Z",
    latestTurn: {
      requestedAt: "2026-08-08T11:58:00.000Z",
      startedAt: "2026-08-08T11:58:01.000Z",
      completedAt: "2026-08-08T11:59:00.000Z",
    } as OrchestrationThreadShell["latestTurn"],
  });

  assert.deepEqual(threadIsQuiescent(thread, { now: NOW }), { quiescent: false });
});

it("becomes quiescent after the queued-start grace expires", () => {
  const thread = threadWith({ latestUserMessageAt: "2026-08-08T11:57:59.999Z" });

  assert.deepEqual(threadIsQuiescent(thread, { now: NOW }), { quiescent: true });
});

it("does not wedge on negative clock skew outside the grace bound", () => {
  const thread = threadWith({ latestUserMessageAt: "2026-08-08T12:05:00.000Z" });

  assert.deepEqual(threadIsQuiescent(thread, { now: NOW }), { quiescent: true });
});

it("treats an adopted ready thread as quiescent", () => {
  const thread = threadWith({
    latestUserMessageAt: "2026-08-08T11:59:00.000Z",
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-08-08T11:59:00.000Z",
      startedAt: "2026-08-08T11:59:01.000Z",
      completedAt: "2026-08-08T11:59:30.000Z",
      assistantMessageId: null,
    } as OrchestrationThreadShell["latestTurn"],
  });

  assert.deepEqual(threadIsQuiescent(thread, { now: NOW }), { quiescent: true });
});
