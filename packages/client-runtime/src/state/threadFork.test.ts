import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canForkConversation } from "./threadFork.ts";

describe("canForkConversation", () => {
  const thread = {
    latestTurn: null,
    session: {
      providerName: "codex",
      status: "ready",
      activeTurnId: null,
      lastError: null,
    },
  } as Pick<OrchestrationThreadShell, "latestTurn" | "session">;

  it("allows an idle supported provider session", () => {
    expect(canForkConversation(thread)).toBe(true);
  });

  it("rejects running sessions and prior fork failures", () => {
    expect(
      canForkConversation({
        ...thread,
        session: thread.session ? { ...thread.session, status: "running" } : null,
      }),
    ).toBe(false);
    expect(
      canForkConversation({
        ...thread,
        session: thread.session
          ? {
              ...thread.session,
              lastError: "Conversation fork failed: source is unavailable",
            }
          : null,
      }),
    ).toBe(false);
  });
});
