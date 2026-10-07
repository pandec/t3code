import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadArchiveScheduler from "../../../orchestration-v2/ThreadArchiveScheduler.ts";
import { readOwnedCaller, readThread, readWritableThread } from "../../threadAccess.ts";
import { ArchiveToolkit } from "./tools.ts";

const toResult = (status: ThreadArchiveScheduler.ThreadArchiveStatus) => ({
  archivedAt: status.archivedAt === null ? null : DateTime.formatIso(status.archivedAt),
  request: status.request,
});

const failure = (error: ThreadArchiveScheduler.ThreadArchiveSchedulerError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail });

/**
 * The credential's own thread when omitted (readable after it is archived);
 * otherwise any thread for status, or a writable one within the caller's modes.
 */
const resolveTarget = (threadId: ThreadId | undefined, write: boolean) =>
  threadId === undefined
    ? readOwnedCaller().pipe(Effect.map((thread) => thread.id))
    : (write ? readWritableThread(threadId) : readThread(threadId)).pipe(
        Effect.map((context) => context.projection.thread.id),
      );

export const ArchiveToolkitHandlersLive = ArchiveToolkit.toLayer({
  archive_thread: (input) =>
    Effect.gen(function* () {
      const threadId = yield* resolveTarget(input.threadId, true);
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      return toResult(
        yield* scheduler
          .schedule({ threadId, afterTurn: true, removeWorktree: input.removeWorktree === true })
          .pipe(Effect.mapError(failure)),
      );
    }),
  archive_thread_status: (input) =>
    Effect.gen(function* () {
      const threadId = yield* resolveTarget(input.threadId, false);
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      return toResult(yield* scheduler.status(threadId).pipe(Effect.mapError(failure)));
    }),
  cancel_thread_archive: (input) =>
    Effect.gen(function* () {
      const threadId = yield* resolveTarget(input.threadId, true);
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      return toResult(yield* scheduler.cancel({ threadId }).pipe(Effect.mapError(failure)));
    }),
});
