import {
  IsoDateTime,
  OrchestrationV2ThreadArchiveRequest,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadArchiveScheduler from "../../../orchestration-v2/ThreadArchiveScheduler.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Fork: deferred archive tools for the credential's own thread or a target thread. */
export const ArchiveToolResult = Schema.Struct({
  archivedAt: Schema.NullOr(IsoDateTime),
  request: Schema.NullOr(OrchestrationV2ThreadArchiveRequest),
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadArchiveScheduler.ThreadArchiveScheduler,
];

const threadId = Schema.optional(
  ThreadId.annotate({
    description:
      "Target another thread, in any project. Omit for this thread. Use it, for example, to read thread X's messages with t3_thread_read and then archive X once it is no longer needed.",
  }),
);

const ArchiveThread = Tool.make("archive_thread", {
  description:
    "Archive a thread once its current turn succeeds, its final checkpoint lands, and background work such as subagents and monitors finishes; an idle thread archives immediately. Without threadId this targets your own thread: use it when the user asks to archive this thread when you are done, then finish your response without waiting for your own turn to end (a pending request means scheduled, not archived). With threadId it archives that other thread, which must run within your own runtime and interaction modes. Only set removeWorktree=true when the user also asks to remove the worktree. Removal preserves the branch and refuses dirty, locked, detached, shared, or project-checkout worktrees; a refusal after archiving leaves the thread archived and records the reason. Failed or interrupted turns, a Stop, or a new message from the user or an agent to the target thread cancel the request; automatic wakes such as subagent results or background notifications are waited through. Use archive_thread_status to inspect or cancel_thread_archive to cancel before archiving starts.",
  parameters: Schema.Struct({
    threadId,
    removeWorktree: Schema.optional(
      Schema.Boolean.annotate({
        description: "Also remove the thread's clean worktree after archiving. Defaults to false.",
      }),
    ),
  }),
  success: ArchiveToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Archive a thread when done")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

const ArchiveThreadStatus = Tool.make("archive_thread_status", {
  description:
    "Read a thread's archive state and latest archive request, including pending, completed, cancelled, or error status and its detail; works for archived threads. Omit threadId for this thread, where a pending request verifies scheduling and you should finish your turn so it can run. On an archived thread, pending means its worktree removal is still running, and error carries why the worktree was kept. Null means no archive request exists.",
  parameters: Schema.Struct({ threadId }),
  success: ArchiveToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get thread archive status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const CancelThreadArchive = Tool.make("cancel_thread_archive", {
  description:
    "Cancel a thread's pending archive before archiving starts; omit threadId for this thread. Does not restore an archived thread. Returns the current state when there is no pending request.",
  parameters: Schema.Struct({ threadId }),
  success: ArchiveToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel thread archive")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const ArchiveToolkit = Toolkit.make(ArchiveThread, ArchiveThreadStatus, CancelThreadArchive);
