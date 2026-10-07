import {
  NonNegativeInt,
  OrchestrationV2RunStatus,
  OrchestratorMcpFailure,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Fork: whether a thread has gone fully quiet, for session handovers. */
export const ThreadDrainStatusResult = Schema.Struct({
  threadId: ThreadId,
  archived: Schema.Boolean,
  /** No foreground run, nothing queued, and no background work left. */
  quiet: Schema.Boolean,
  activeRun: Schema.NullOr(Schema.Struct({ runId: RunId, status: OrchestrationV2RunStatus })),
  queuedRunCount: NonNegativeInt,
  backgroundWork: Schema.Struct({
    liveness: Schema.NullOr(Schema.Literals(["working", "monitoring"])),
    tasks: Schema.Array(
      Schema.Struct({
        taskId: Schema.String,
        kind: Schema.String,
        description: Schema.optional(Schema.String),
      }),
    ),
  }),
});

const ThreadDrainStatus = Tool.make("t3_thread_drain_status", {
  description:
    "Check whether a T3 thread is fully quiet, e.g. before handing its session over to another machine. Omit threadId for this thread; any thread in the environment, archived ones included, can be read. quiet=true means no foreground run is active (preparing, starting, running, or waiting on a question), no queued runs remain, and no background work survives the turn. Otherwise activeRun, queuedRunCount, and backgroundWork.tasks (native subagents, background tasks, monitors, and background commands such as dev servers, each with its kind) say what is still going. Reading this from the thread itself always reports its own active run, so check from another thread or after your turn ends. This reads once; poll with a bounded loop rather than spinning.",
  parameters: Schema.Struct({
    threadId: Schema.optional(
      ThreadId.annotate({ description: "Thread to check. Omit for this thread." }),
    ),
  }),
  success: ThreadDrainStatusResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Check thread drain status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadDrainToolkit = Toolkit.make(ThreadDrainStatus);
