import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadArchiveScheduler from "../../../orchestration-v2/ThreadArchiveScheduler.ts";
import { readOwnedCaller } from "../../threadAccess.ts";
import { ArchiveToolkit } from "./tools.ts";

const toResult = (status: ThreadArchiveScheduler.ThreadArchiveStatus) => ({
  archivedAt: status.archivedAt === null ? null : DateTime.formatIso(status.archivedAt),
  request: status.request,
});

const failure = (error: ThreadArchiveScheduler.ThreadArchiveSchedulerError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail });

export const ArchiveToolkitHandlersLive = ArchiveToolkit.toLayer({
  archive_thread: (input) =>
    Effect.gen(function* () {
      const thread = yield* readOwnedCaller();
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      return toResult(
        yield* scheduler
          .schedule({
            threadId: thread.id,
            afterTurn: true,
            removeWorktree: input.removeWorktree === true,
          })
          .pipe(Effect.mapError(failure)),
      );
    }),
  archive_thread_status: () =>
    Effect.gen(function* () {
      const thread = yield* readOwnedCaller();
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      return toResult(yield* scheduler.status(thread.id).pipe(Effect.mapError(failure)));
    }),
  cancel_thread_archive: () =>
    Effect.gen(function* () {
      const thread = yield* readOwnedCaller();
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      return toResult(
        yield* scheduler.cancel({ threadId: thread.id }).pipe(Effect.mapError(failure)),
      );
    }),
});
