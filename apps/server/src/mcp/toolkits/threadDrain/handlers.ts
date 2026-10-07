import * as Effect from "effect/Effect";

import { latestActiveRun } from "../../../orchestration-v2/ThreadManagementService.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import { ThreadDrainToolkit } from "./tools.ts";

export const ThreadDrainToolkitHandlersLive = ThreadDrainToolkit.toLayer({
  t3_thread_drain_status: (input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readThread(input.threadId, ["runs"]);
      // Scope "all": a handover must also wait out monitors and background commands.
      const drain = yield* threads
        .getBackgroundWorkDrain({
          projectId: projection.thread.projectId,
          threadId: projection.thread.id,
          scope: "all",
        })
        .pipe(Effect.mapError(unavailable));
      const activeRun = latestActiveRun(projection);
      const queuedRunCount = projection.runs.filter((run) => run.status === "queued").length;
      return {
        threadId: projection.thread.id,
        archived: projection.thread.archivedAt !== null,
        quiet: drain.drained && activeRun === undefined && queuedRunCount === 0,
        activeRun:
          activeRun === undefined ? null : { runId: activeRun.id, status: activeRun.status },
        queuedRunCount,
        backgroundWork: {
          liveness: drain.liveness,
          tasks: drain.pendingTasks.map((task) => ({
            taskId: task.taskId,
            kind: task.kind,
            ...(task.description === undefined ? {} : { description: task.description }),
          })),
        },
      };
    }),
});
