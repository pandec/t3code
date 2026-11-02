import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadArchiveScheduler from "../../../orchestration-v2/ThreadArchiveScheduler.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  readOwnedCaller,
  readThread,
  readCaller,
  assertTargetWithinLimits,
} from "../../threadAccess.ts";
import { assertSameLink } from "../../linkOrigin.ts";
import { DispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import { ArchiveToolkit } from "./tools.ts";

/** Also returned by `t3_thread_organize` for its archive action. */
export const toResult = (status: ThreadArchiveScheduler.ThreadArchiveStatus) => ({
  archivedAt: status.archivedAt === null ? null : DateTime.formatIso(status.archivedAt),
  request: status.request,
  ...(status.descendants === undefined ? {} : { descendants: status.descendants }),
});

export const failure = (error: ThreadArchiveScheduler.ThreadArchiveSchedulerError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail });

/** The credential's own thread when omitted (readable after it is archived), else that thread. */
const resolveTarget = (threadId: ThreadId | undefined) =>
  threadId === undefined
    ? readOwnedCaller().pipe(Effect.map((thread) => thread.id))
    : readThread(threadId).pipe(Effect.map((context) => context.projection.thread.id));

/** Its own thread needs only ownership; another thread must be writable within the caller's modes. */
const archiveAccess = (input: { readonly threadId?: ThreadId | undefined }) =>
  input.threadId === undefined
    ? ({ _tag: "actsOnOwnThread" } as const)
    : ({ _tag: "writesThreads", threads: [input.threadId] } as const);

export const ArchiveToolkitHandlersLive = McpToolAccess.toLayer(ArchiveToolkit, {
  archive_thread: McpToolAccess.dependsOnParams(archiveAccess, (input) =>
    Effect.gen(function* () {
      const threadId = yield* resolveTarget(input.threadId);
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      const caller = input.includeDescendants === true ? yield* readCaller() : undefined;
      const scheduled = scheduler
        .schedule({
          threadId,
          afterTurn: true,
          removeWorktree: input.removeWorktree === true,
          ...(caller === undefined
            ? {}
            : {
                includeDescendants: true,
                authorizeDescendant: (thread) =>
                  assertTargetWithinLimits(caller.limits, thread).pipe(
                    Effect.andThen(assertSameLink(caller, thread)),
                  ),
              }),
        })
        .pipe(Effect.mapError(failure));
      return toResult(
        yield* caller === undefined
          ? scheduled
          : scheduled.pipe(Effect.provideService(DispatchModeLimit, caller.limits)),
      );
    }),
  ),
  archive_thread_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const threadId = yield* resolveTarget(input.threadId);
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      return toResult(yield* scheduler.status(threadId).pipe(Effect.mapError(failure)));
    }),
  ),
  cancel_thread_archive: McpToolAccess.dependsOnParams(archiveAccess, (input) =>
    Effect.gen(function* () {
      const threadId = yield* resolveTarget(input.threadId);
      const scheduler = yield* ThreadArchiveScheduler.ThreadArchiveScheduler;
      return toResult(yield* scheduler.cancel({ threadId }).pipe(Effect.mapError(failure)));
    }),
  ),
});
