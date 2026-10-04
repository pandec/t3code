import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadArchiveScheduler from "../../../orchestration-v2/ThreadArchiveScheduler.ts";
import { readCaller } from "../../threadAccess.ts";
import { ArchiveToolkit } from "./tools.ts";

/**
 * Resolves the credential's own thread, archived ones included so status stays
 * readable after the archive runs, and rejects a provider that no longer owns it.
 */
const readOwnedThread = Effect.gen(function* () {
  const { scope, caller } = yield* readCaller();
  if (caller.providerInstanceId !== scope.providerInstanceId) {
    return yield* new OrchestratorMcpFailure({
      code: "parent_not_active",
      message: "This provider no longer owns the thread.",
    });
  }
  return caller;
});

const toResult = (status: ThreadArchiveScheduler.ThreadArchiveStatus) => ({
  archivedAt: status.archivedAt === null ? null : DateTime.formatIso(status.archivedAt),
  request: status.request,
});

const failure = (error: ThreadArchiveScheduler.ThreadArchiveSchedulerError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail });

export const ArchiveToolkitHandlersLive = ArchiveToolkit.toLayer({
  archive_thread: () =>
    Effect.gen(function* () {
      const thread = yield* readOwnedThread;
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      return toResult(
        yield* scheduler
          .schedule({ threadId: thread.id, afterTurn: true })
          .pipe(Effect.mapError(failure)),
      );
    }),
  archive_thread_status: () =>
    Effect.gen(function* () {
      const thread = yield* readOwnedThread;
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      return toResult(yield* scheduler.status(thread.id).pipe(Effect.mapError(failure)));
    }),
  cancel_thread_archive: () =>
    Effect.gen(function* () {
      const thread = yield* readOwnedThread;
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      return toResult(
        yield* scheduler.cancel({ threadId: thread.id }).pipe(Effect.mapError(failure)),
      );
    }),
});
