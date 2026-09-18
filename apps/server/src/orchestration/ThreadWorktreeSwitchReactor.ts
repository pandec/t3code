import { CommandId, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { resolveWorktreeSwitchTarget, WorktreeSwitchError } from "./worktreeSwitch.ts";

export class ThreadWorktreeSwitchReactor extends Context.Service<
  ThreadWorktreeSwitchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadWorktreeSwitchReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const threads = yield* ProjectionThreadRepository;
  const crypto = yield* Crypto.Crypto;
  const process = Effect.fn("ThreadWorktreeSwitchReactor.process")(function* (threadId: ThreadId) {
    const row = yield* threads.getById({ threadId });
    if (
      Option.isNone(row) ||
      row.value.deletedAt !== null ||
      row.value.worktreeSwitch?.status !== "pending"
    )
      return;
    const request = row.value.worktreeSwitch;
    yield* withWorkspaceLease(
      request.targetPath,
      Effect.gen(function* () {
        const project = yield* snapshots.getProjectShellById(row.value.projectId);
        const target = yield* (
          Option.isSome(project)
            ? resolveWorktreeSwitchTarget(project.value.workspaceRoot, request.targetPath)
            : Effect.fail(new WorktreeSwitchError({ message: "The project no longer exists." }))
        ).pipe(
          Effect.map((value) => ({ ...value, error: undefined })),
          Effect.catchTag("WorktreeSwitchError", (error) =>
            Effect.succeed({
              branch: null,
              worktreePath: null,
              error: error.message,
            }),
          ),
        );
        yield* engine
          .dispatch({
            type: "thread.worktree-switch.execute",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            requestId: request.requestId,
            branch: target.branch,
            worktreePath: target.worktreePath,
            ...(target.error ? { error: target.error } : {}),
          })
          .pipe(Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.void));
      }),
    );
  });
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    process(threadId).pipe(
      Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis") }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Worktree switch failed", { threadId, cause: Cause.pretty(cause) }),
      ),
    ),
  );
  const start = Effect.fn("ThreadWorktreeSwitchReactor.start")(function* () {
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
            return event.payload.worktreeSwitch !== undefined ||
              event.payload.worktreePath !== undefined ||
              event.payload.branch !== undefined ||
              event.payload.archiveRequest !== undefined
              ? worker.enqueue(event.payload.threadId)
              : Effect.void;
          default:
            return Effect.void;
        }
      }),
    );
    yield* forkParked(
      Effect.gen(function* () {
        const pending = yield* threads.listPendingWorktreeSwitches();
        yield* Effect.forEach(pending, worker.enqueue, { discard: true });
      }).pipe(
        Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis") }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Worktree switch recovery failed", { cause }),
        ),
      ),
    );
  });
  return { start, drain: worker.drain };
});
export const layer = Layer.effect(ThreadWorktreeSwitchReactor, make);
