import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { threadCliState, threadHasActiveTurn } from "./threadState.ts";

const threadWith = (
  input: Pick<OrchestrationThreadShell, "session" | "latestTurn">,
): OrchestrationThreadShell => input as OrchestrationThreadShell;

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
    latestTurn: null,
  });

  assert.equal(threadCliState(thread), "running");
  assert.isFalse(threadHasActiveTurn(thread));
});

it("requires evidence of an active turn before allowing interruption", () => {
  const transitional = threadWith({
    session: { status: "running", activeTurnId: null } as OrchestrationThreadShell["session"],
    latestTurn: null,
  });
  const active = threadWith({
    session: {
      status: "running",
      activeTurnId: "turn-1",
    } as OrchestrationThreadShell["session"],
    latestTurn: null,
  });

  assert.isFalse(threadHasActiveTurn(transitional));
  assert.isTrue(threadHasActiveTurn(active));
});
