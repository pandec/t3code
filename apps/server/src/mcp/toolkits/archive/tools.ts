import {
  IsoDateTime,
  OrchestrationV2ThreadArchiveRequest,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ThreadArchiveScheduler from "../../../orchestration-v2/ThreadArchiveScheduler.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Fork: deferred archive tools for the credential's own thread. */
export const ArchiveToolResult = Schema.Struct({
  archivedAt: Schema.NullOr(IsoDateTime),
  request: Schema.NullOr(OrchestrationV2ThreadArchiveRequest),
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadArchiveScheduler.ThreadArchiveScheduler,
];

const ArchiveThread = Tool.make("archive_thread", {
  description:
    "When the user asks to archive this thread when you are done, schedule its archive after the current turn succeeds, its final checkpoint lands, and background work such as subagents and monitors finishes. Only set removeWorktree=true when the user also asks to remove the worktree. Removal preserves the branch and refuses dirty, locked, detached, shared, or project-checkout worktrees; a refusal after archiving leaves the thread archived and records the reason. A pending request means scheduled, not archived: finish your response without waiting for your own turn to end. Failed or interrupted turns, a Stop, or a new message from the user or an agent cancel the request; automatic wakes such as subagent results or background notifications are waited through. Idle threads archive immediately. Use archive_thread_status to inspect or cancel_thread_archive to cancel before archiving starts.",
  parameters: Schema.Struct({
    removeWorktree: Schema.optional(
      Schema.Boolean.annotate({
        description: "Also remove this thread's clean worktree after archiving. Defaults to false.",
      }),
    ),
  }),
  success: ArchiveToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Archive this thread when done")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

const ArchiveThreadStatus = Tool.make("archive_thread_status", {
  description:
    "Read this thread's archive state and latest archive request, including pending, completed, cancelled, or error status and its detail. A pending request verifies scheduling; finish your turn so it can run. On an archived thread, pending means its worktree removal is still running, and error carries why the worktree was kept. Null means no archive request exists.",
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
    "Cancel this thread's pending archive before archiving starts. Does not restore an archived thread. Returns the current state when there is no pending request.",
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
