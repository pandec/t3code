/**
 * Fork: deferred agent-requested worktree switch service. Validates and
 * records a request for MCP, CLI and other callers, and applies pending
 * requests once their run and background work finish (rules in
 * DeferredWorktreeSwitch.ts). The target is resolved again under its
 * workspace lease right before the switch, so a checkout removed meanwhile
 * ends as `error`. Requests are thread state in the event log, so `start`
 * re-checks every pending request after a restart.
 */
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadWorktreeSwitch,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { isThreadPayloadEvent } from "./DeferredArchive.ts";
import { evaluateWorktreeSwitch, pendingWorktreeSwitch } from "./DeferredWorktreeSwitch.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { eventCanSettleDeferredArchive } from "./ThreadArchiveScheduler.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { resolveWorktreeSwitchTarget, WorktreeSwitchError } from "./worktreeSwitch.ts";

export interface ThreadWorktreeSwitchStatus {
  readonly request: OrchestrationV2ThreadWorktreeSwitch | null;
}

export class ThreadWorktreeSwitchScheduler extends Context.Service<
  ThreadWorktreeSwitchScheduler,
  {
    /**
     * Switch `threadId` to `targetPath`, an absolute existing checkout of its
     * repository (the project root returns to the main checkout), after its
     * running run completes. Replaces a pending request.
     */
    readonly request: (input: {
      readonly threadId: ThreadId;
      readonly targetPath: string;
      readonly commandId?: CommandId;
    }) => Effect.Effect<ThreadWorktreeSwitchStatus, WorktreeSwitchError>;
    /** The latest request, or null when none was made. */
    readonly status: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadWorktreeSwitchStatus, WorktreeSwitchError>;
    /** Cancels a pending request; returns the current state when none is pending. */
    readonly cancel: (input: {
      readonly threadId: ThreadId;
      readonly commandId?: CommandId;
    }) => Effect.Effect<ThreadWorktreeSwitchStatus, WorktreeSwitchError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Re-checks every pending request (startup) and waits for the work to finish. */
    readonly reconcilePending: Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadWorktreeSwitchScheduler") {}

function errorDetail(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    const nested = (cause as { readonly cause?: unknown }).cause;
    if (typeof nested === "string") return nested;
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The worktree switch could not be completed.";
}

const toSwitchError = (cause: unknown) => new WorktreeSwitchError({ message: errorDetail(cause) });

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providePlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const newCommandId = (prefix: string, threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${prefix}:${threadId}:${uuid}`)),
    );

  const status = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, []).pipe(
      Effect.map(({ thread }): ThreadWorktreeSwitchStatus => ({
        request: thread.worktreeSwitch ?? null,
      })),
      Effect.mapError(toSwitchError),
    );

  /** Resolves `targetPath` against the thread's project; fails with a user-facing reason. */
  const resolveTarget = (projectId: Parameters<typeof projects.getShell>[0], targetPath: string) =>
    Effect.gen(function* () {
      const project = yield* projects.getShell(projectId).pipe(Effect.mapError(toSwitchError));
      if (Option.isNone(project)) {
        return yield* new WorktreeSwitchError({ message: "The project no longer exists." });
      }
      return yield* resolveWorktreeSwitchTarget(project.value.workspaceRoot, targetPath);
    }).pipe(providePlatform);

  // Threads whose latest known state has a pending request; events on other
  // threads never cost a read.
  const tracked = new Set<ThreadId>();
  const queued = new Set<ThreadId>();

  const process = Effect.fn("ThreadWorktreeSwitchScheduler.process")(function* (
    threadId: ThreadId,
  ) {
    const { thread, runs, checkpoints } = yield* threads.getThreadRecords(threadId, [
      "runs",
      "checkpoints",
    ]);
    const request = pendingWorktreeSwitch(thread);
    if (request === null) {
      tracked.delete(threadId);
      return;
    }
    tracked.add(threadId);
    const shell = yield* threads.getThreadShell(threadId);
    const decision = evaluateWorktreeSwitch({
      thread,
      request,
      runs,
      checkpoints,
      pendingBackgroundTasks: shell?.pendingBackgroundTasks ?? [],
    });
    if (decision.type === "wait") return;
    const execute = (
      outcome:
        | { readonly target: { worktreePath: string | null; branch: string | null } }
        | { readonly error: string }
        | Record<string, never>,
    ) =>
      Effect.gen(function* () {
        yield* threads.dispatch({
          type: "thread.worktree-switch.execute",
          commandId: yield* newCommandId("worktree-switch-execute", threadId),
          threadId,
          requestId: request.requestId,
          ...outcome,
        });
      });
    // The orchestrator records the cancellation or failure.
    if (decision.type === "cancel" || decision.type === "fail") return yield* execute({});
    // Hold the target's lease so archive cleanup cannot remove it mid-switch.
    yield* withWorkspaceLease(
      request.targetPath,
      resolveTarget(thread.projectId, request.targetPath).pipe(
        Effect.map((target) => ({
          target: { worktreePath: target.worktreePath, branch: target.branch },
        })),
        Effect.catchTags({
          WorktreeSwitchError: (error) => Effect.succeed({ error: error.message }),
        }),
        Effect.flatMap(execute),
      ),
    ).pipe(providePlatform);
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(
      Effect.andThen(process(threadId)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("deferred worktree switch check failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );
  const enqueue = (threadId: ThreadId) =>
    Effect.suspend(() => {
      if (queued.has(threadId)) return Effect.void;
      queued.add(threadId);
      return worker.enqueue(threadId);
    }).pipe(Effect.uninterruptible);

  const onEvent = (event: OrchestrationV2DomainEvent) => {
    if (isThreadPayloadEvent(event)) {
      if (pendingWorktreeSwitch(event.payload) === null) {
        tracked.delete(event.threadId);
        return Effect.void;
      }
      tracked.add(event.threadId);
      return enqueue(event.threadId);
    }
    return tracked.has(event.threadId) && eventCanSettleDeferredArchive(event)
      ? enqueue(event.threadId)
      : Effect.void;
  };

  const reconcilePending = sql<{ readonly thread_id: ThreadId }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.worktreeSwitch.status') = 'pending'
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) => enqueue(row.thread_id), { discard: true }),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("deferred worktree switch recovery failed", { cause }),
    ),
    Effect.andThen(worker.drain),
  );

  return ThreadWorktreeSwitchScheduler.of({
    request: (input) =>
      Effect.gen(function* () {
        const { thread } = yield* threads
          .getThreadRecords(input.threadId, [])
          .pipe(Effect.mapError(toSwitchError));
        const target = yield* resolveTarget(thread.projectId, input.targetPath);
        yield* threads
          .dispatch({
            type: "thread.worktree-switch.schedule",
            commandId:
              input.commandId ?? (yield* newCommandId("worktree-switch-schedule", input.threadId)),
            threadId: input.threadId,
            targetPath: target.targetPath,
          })
          .pipe(Effect.mapError(toSwitchError));
        return yield* status(input.threadId);
      }),
    status,
    cancel: (input) =>
      Effect.gen(function* () {
        const current = yield* status(input.threadId);
        if (current.request?.status !== "pending") return current;
        yield* threads
          .dispatch({
            type: "thread.worktree-switch.cancel",
            commandId:
              input.commandId ?? (yield* newCommandId("worktree-switch-cancel", input.threadId)),
            threadId: input.threadId,
          })
          .pipe(Effect.mapError(toSwitchError));
        return yield* status(input.threadId);
      }),
    start: Effect.fn("ThreadWorktreeSwitchScheduler.start")(function* () {
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, onEvent).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("deferred worktree switch event stream failed", { cause }),
          ),
        ),
      );
      yield* forkParked(reconcilePending);
    }),
    reconcilePending,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(ThreadWorktreeSwitchScheduler, make);

/** Starts the deferred worktree switch worker with the server. */
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* ThreadWorktreeSwitchScheduler;
    yield* scheduler.start();
  }),
);
