import { IsoDateTime, ThreadArchiveRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export class ThreadArchiveError extends Schema.TaggedError<ThreadArchiveError>()(
  "ThreadArchiveError",
  { message: Schema.String },
) {}

const result = Schema.Struct({
  archivedAt: Schema.NullOr(IsoDateTime),
  request: Schema.NullOr(ThreadArchiveRequest),
});

const ArchiveThread = Tool.make("archive_thread", {
  description:
    "When the user asks to archive this thread when you are done, schedule its archive after the current turn succeeds, its final checkpoint lands, and background work finishes. Only set removeWorktree=true when the user also asks to remove the worktree. Removal preserves the branch and refuses dirty, locked, detached, shared, or project-checkout worktrees. A cleanup failure leaves the thread archived and records the error. A pending request means scheduled, not archived: finish your response without waiting for your own turn to end. Failed/interrupted turns or newer work cancel the request. Idle threads archive immediately. Use archive_thread_status to inspect or cancel_thread_archive to cancel before archiving starts.",
  parameters: Schema.Struct({
    removeWorktree: Schema.optional(
      Schema.Boolean.annotate({
        description: "Also remove this thread's clean worktree after archiving. Defaults to false.",
      }),
    ),
  }),
  success: result,
  failure: ThreadArchiveError,
  dependencies: [McpInvocationContext],
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

const ArchiveThreadStatus = Tool.make("archive_thread_status", {
  description:
    "Read this thread's archive state and latest archive request, including pending, completed, cancelled, or error status and any cleanup failure. A pending request verifies scheduling; finish your turn so it can run. Null means no archive request exists.",
  success: result,
  failure: ThreadArchiveError,
  dependencies: [McpInvocationContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const CancelThreadArchive = Tool.make("cancel_thread_archive", {
  description:
    "Cancel this thread's pending archive before archiving starts. Does not restore an archived thread or undo worktree removal. Returns the current state when there is no pending request.",
  success: result,
  failure: ThreadArchiveError,
  dependencies: [McpInvocationContext],
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const ArchiveToolkit = Toolkit.make(ArchiveThread, ArchiveThreadStatus, CancelThreadArchive);
