import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRunSummary, ThreadRuntimeSummary } from "./models.ts";
import {
  canForkConversation,
  canForkImportedSessionWith,
  conversationForkRunId,
  conversationForkTarget,
} from "./threadFork.ts";

const threadId = ThreadId.make("thread-fork-source");
const runId = RunId.make("run-fork-latest");

function run(status: ThreadRunSummary["status"]): ThreadRunSummary {
  return {
    runId,
    status,
    requestedAt: "2026-10-04T10:00:00.000Z",
    startedAt: "2026-10-04T10:00:01.000Z",
    completedAt: null,
    assistantMessageId: null,
  };
}

function runtime(status: ThreadRuntimeSummary["status"]): ThreadRuntimeSummary {
  return {
    status,
    activeRunId: status === "idle" ? null : runId,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerName: "claudeAgent",
    lastError: null,
    updatedAt: "2026-10-04T10:00:02.000Z",
  };
}

function thread(overrides: Partial<Parameters<typeof conversationForkRunId>[0]> = {}) {
  return {
    archivedAt: null,
    deletedAt: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    latestRun: run("completed"),
    runtime: runtime("idle"),
    activeProviderThreadId: ProviderThreadId.make("provider-thread-fork-source"),
    ...overrides,
  } satisfies Parameters<typeof conversationForkRunId>[0];
}

describe("conversationForkRunId", () => {
  it("forks through the latest finished run, including failed and interrupted turns", () => {
    for (const status of ["completed", "failed", "interrupted", "cancelled"] as const) {
      expect(conversationForkRunId(thread({ latestRun: run(status) }))).toBe(runId);
    }
  });

  it("withholds the fork while work is live or the latest run is unfinished", () => {
    expect(canForkConversation(thread({ runtime: runtime("running") }))).toBe(false);
    expect(canForkConversation(thread({ runtime: runtime("queued") }))).toBe(false);
    expect(canForkConversation(thread({ latestRun: run("rolled_back") }))).toBe(false);
  });

  it("forks a runless imported session natively, but not runless legacy history", () => {
    const importable = { canForkImportedSession: true };
    expect(conversationForkTarget(thread({ latestRun: null, runtime: null }), importable)).toEqual({
      type: "imported-session",
    });
    // Providers that cannot fork a native session (e.g. ACP imports) hide the action.
    expect(conversationForkTarget(thread({ latestRun: null, runtime: null }))).toBeNull();
    expect(conversationForkRunId(thread({ latestRun: null }))).toBeNull();
    // Legacy threads migrated at the v2 upgrade have no provider thread.
    expect(
      canForkConversation(
        thread({ latestRun: null, runtime: null, activeProviderThreadId: null }),
        importable,
      ),
    ).toBe(false);
    expect(
      canForkConversation(
        thread({ latestRun: null, archivedAt: "2026-10-04T11:00:00.000Z", runtime: null }),
        importable,
      ),
    ).toBe(false);
  });

  it("resolves imported-session fork support from the thread's provider driver", () => {
    const providers = [
      {
        instanceId: ProviderInstanceId.make("claude_work"),
        driver: ProviderDriverKind.make("claudeAgent"),
      },
      { instanceId: ProviderInstanceId.make("gemini"), driver: ProviderDriverKind.make("acp") },
    ];
    expect(canForkImportedSessionWith(ProviderInstanceId.make("claude_work"), providers)).toBe(
      true,
    );
    expect(canForkImportedSessionWith(ProviderInstanceId.make("gemini"), providers)).toBe(false);
    expect(canForkImportedSessionWith(ProviderInstanceId.make("missing"), providers)).toBe(false);
    expect(canForkImportedSessionWith(ProviderInstanceId.make("claude_work"), undefined)).toBe(
      false,
    );
  });

  it("withholds the fork for archived, deleted and subagent threads", () => {
    expect(canForkConversation(thread({ archivedAt: "2026-10-04T11:00:00.000Z" }))).toBe(false);
    expect(canForkConversation(thread({ deletedAt: "2026-10-04T11:00:00.000Z" }))).toBe(false);
    expect(
      canForkConversation(
        thread({
          lineage: {
            parentThreadId: ThreadId.make("thread-parent"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("thread-parent"),
          },
        }),
      ),
    ).toBe(false);
  });
});
