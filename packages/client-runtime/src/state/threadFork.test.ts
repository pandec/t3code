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

  // Both clients now share these clauses, so silently dropping one would offer
  // a fork mid-turn everywhere at once.
  it("rejects mid-turn work, unsupported providers, and missing sessions", () => {
    const withSession = (patch: Record<string, unknown>) =>
      canForkConversation({
        ...thread,
        session: thread.session ? { ...thread.session, ...patch } : null,
      });

    expect(withSession({ providerName: "opencode" })).toBe(false);
    expect(withSession({ status: "starting" })).toBe(false);
    expect(withSession({ status: "error" })).toBe(false);
    expect(withSession({ activeTurnId: "turn_1" })).toBe(false);
    expect(canForkConversation({ ...thread, session: null })).toBe(false);
    expect(
      canForkConversation({
        ...thread,
        latestTurn: { state: "running" } as OrchestrationThreadShell["latestTurn"],
      }),
    ).toBe(false);
  });
});
