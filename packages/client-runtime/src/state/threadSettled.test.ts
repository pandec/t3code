import {
  CommandId,
  type OrchestrationV2PendingBackgroundTask,
  ProviderInstanceId,
  RunId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRuntimeSummary } from "./models.ts";
import { resolveArchiveToggleAction } from "./threadSettled.ts";

function runtime(status: ThreadRuntimeSummary["status"]): ThreadRuntimeSummary {
  return {
    status,
    activeRunId: status === "idle" ? null : RunId.make("run-1"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-10-04T10:00:00.000Z",
  };
}

const idle = {
  archivedAt: null,
  archiveRequest: null,
  runtime: runtime("idle"),
  pendingBackgroundTasks: [] as ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
};

describe("resolveArchiveToggleAction", () => {
  it("archives an idle thread now", () => {
    expect(resolveArchiveToggleAction(idle)).toBe("archive");
  });

  it("archives a busy thread when done", () => {
    expect(resolveArchiveToggleAction({ ...idle, runtime: runtime("running") })).toBe("schedule");
    expect(
      resolveArchiveToggleAction({
        ...idle,
        pendingBackgroundTasks: [{ kind: "subagent", taskId: "agent-1" }],
      }),
    ).toBe("schedule");
  });

  it("does not wait on background commands such as dev servers", () => {
    expect(
      resolveArchiveToggleAction({
        ...idle,
        pendingBackgroundTasks: [{ kind: "command", taskId: "dev-server" }],
      }),
    ).toBe("archive");
  });

  it("cancels a pending archive", () => {
    expect(
      resolveArchiveToggleAction({
        ...idle,
        runtime: runtime("running"),
        archiveRequest: {
          requestId: CommandId.make("archive-1"),
          runId: RunId.make("run-1"),
          worktreePath: null,
          requestedAt: "2026-10-04T10:00:00.000Z",
          status: "pending",
        },
      }),
    ).toBe("cancel");
  });
});
