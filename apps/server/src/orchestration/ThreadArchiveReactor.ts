import { CommandId, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

class ArchiveCleanupError extends Schema.TaggedErrorClass<ArchiveCleanupError>()(
  "ArchiveCleanupError",
  { message: Schema.String },
) {}

export class ThreadArchiveReactor extends Context.Service<
  ThreadArchiveReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadArchiveReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const threads = yield* ProjectionThreadRepository;
  const provider = yield* ProviderService;
  const terminals = yield* TerminalManager;
  const git = yield* GitVcsDriver;
  const crypto = yield* Crypto.Crypto;
  const commandId = crypto.randomUUIDv4.pipe(Effect.map(CommandId.make));

  const process = Effect.fn("ThreadArchiveReactor.process")(function* (threadId: ThreadId) {
    let row = yield* threads.getById({ threadId });
    if (
      Option.isNone(row) ||
      row.value.deletedAt !== null ||
      row.value.archiveRequest?.status !== "pending"
    )
      return;
    const request = row.value.archiveRequest;
    if (row.value.archivedAt === null) {
      const accepted = yield* engine
        .dispatch({
          type: "thread.archive.execute",
          commandId: yield* commandId,
          threadId,
          requestId: request.requestId,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.succeed(false)),
        );
      if (!accepted) return;
      row = yield* threads.getById({ threadId });
      if (
        Option.isNone(row) ||
        row.value.archivedAt === null ||
        row.value.archiveRequest?.status !== "pending"
      )
        return;
    }
    const archived = row.value;
    const cleanup = Effect.gen(function* () {
      const sessions = yield* provider.listSessions();
      if (sessions.some((session) => session.threadId === threadId)) {
        yield* provider.stopSession({ threadId });
      }
      yield* terminals.close({ threadId });
      if (!request.removeWorktree || request.worktreePath === null) return;
      // Thread metadata ignores a detached HEAD, so read the live checkout.
      const status = yield* git.statusDetailsLocal(request.worktreePath);
      if (status.isRepo && status.branch === null)
        return yield* new ArchiveCleanupError({
          message: "Detached worktrees require manual removal to preserve unreferenced commits.",
        });
      const snapshot = yield* snapshots.getShellSnapshot();
      const project = snapshot.projects.find((entry) => entry.id === archived.projectId);
      if (!project)
        return yield* Effect.fail(
          new ArchiveCleanupError({ message: "The project no longer exists." }),
        );
      const path = normalizeProjectPathForComparison(request.worktreePath);
      if (path === normalizeProjectPathForComparison(project.workspaceRoot)) {
        return yield* Effect.fail(
          new ArchiveCleanupError({ message: "Refusing to remove the project checkout." }),
        );
      }
      if (
        snapshot.threads.some(
          (thread) =>
            thread.id !== threadId &&
            thread.archivedAt === null &&
            normalizeProjectPathForComparison(
              thread.worktreePath ??
                snapshot.projects.find((entry) => entry.id === thread.projectId)?.workspaceRoot ??
                "",
            ) === path,
        )
      ) {
        return yield* Effect.fail(
          new ArchiveCleanupError({ message: "Another unarchived thread uses this worktree." }),
        );
      }
      // Git refuses dirty or locked worktrees. Keep the branch and never force removal.
      yield* git.removeWorktree({ cwd: project.workspaceRoot, path: request.worktreePath });
    });
    const error = yield* cleanup.pipe(
      Effect.as(undefined),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.succeed(Cause.pretty(cause)),
      ),
    );
    yield* engine.dispatch({
      type: "thread.archive.complete",
      commandId: yield* commandId,
      threadId,
      requestId: request.requestId,
      ...(error ? { error } : {}),
    });
  });
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    process(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Thread archive failed", { threadId, cause: Cause.pretty(cause) }),
      ),
    ),
  );
  const start = Effect.fn("ThreadArchiveReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(events, (event) => {
        switch (event.type) {
          case "thread.archived":
          case "thread.session-set":
          case "thread.turn-diff-completed":
          case "thread.turn-start-requested":
            return worker.enqueue(event.payload.threadId);
          case "thread.activity-appended":
            return event.payload.activity.kind === "task.completed" ||
              event.payload.activity.kind === "task.updated"
              ? worker.enqueue(event.payload.threadId)
              : Effect.void;
          case "thread.meta-updated":
            return event.payload.archiveRequest !== undefined ||
              event.payload.worktreePath !== undefined
              ? worker.enqueue(event.payload.threadId)
              : Effect.void;
          default:
            return Effect.void;
        }
      }),
    );
    yield* forkParked(
      Effect.gen(function* () {
        const pending = yield* threads.listPendingArchives();
        yield* Effect.forEach(pending, (thread) => worker.enqueue(thread), { discard: true });
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Archive recovery failed", { cause })),
      ),
    );
  });
  return { start, drain: worker.drain };
});

export const layer = Layer.effect(ThreadArchiveReactor, make);
