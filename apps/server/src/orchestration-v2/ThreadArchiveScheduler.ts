/**
 * Fork: deferred archive service. Schedules, inspects and cancels a thread's
 * deferred archive for MCP, CLI and other callers, and runs pending requests
 * once their run and background work finish (rules in DeferredArchive.ts).
 * Requests are thread state in the event log, so `start` re-checks every
 * pending request after a restart.
 */
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadArchiveRequest,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import {
  evaluateDeferredArchive,
  isThreadPayloadEvent,
  pendingArchiveRequest,
} from "./DeferredArchive.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export interface ThreadArchiveStatus {
  readonly archivedAt: DateTime.Utc | null;
  readonly request: OrchestrationV2ThreadArchiveRequest | null;
}

export class ThreadArchiveSchedulerError extends Schema.TaggedError<ThreadArchiveSchedulerError>()(
  "ThreadArchiveSchedulerError",
  {
    operation: Schema.Literals(["schedule", "status", "cancel"]),
    threadId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ThreadArchiveScheduler extends Context.Service<
  ThreadArchiveScheduler,
  {
    /** Archive now when idle, otherwise after the active run (requires `afterTurn`). */
    readonly schedule: (input: {
      readonly threadId: ThreadId;
      readonly afterTurn: boolean;
      readonly commandId?: CommandId;
    }) => Effect.Effect<ThreadArchiveStatus, ThreadArchiveSchedulerError>;
    /** Archive state and the latest request; readable after the thread is archived. */
    readonly status: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadArchiveStatus, ThreadArchiveSchedulerError>;
    /** Cancels a pending request; returns the current state when none is pending. */
    readonly cancel: (input: {
      readonly threadId: ThreadId;
      readonly commandId?: CommandId;
    }) => Effect.Effect<ThreadArchiveStatus, ThreadArchiveSchedulerError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Re-checks every pending request (startup) and waits for the work to finish. */
    readonly reconcilePending: Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadArchiveScheduler") {}

/**
 * Events that can make a tracked request ready or void: run lifecycle,
 * background work ending, and thread changes. Streaming output cannot.
 */
export function eventCanSettleDeferredArchive(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "run.created":
    case "run.updated":
    case "run.background-work-cancelled":
    case "provider-thread.updated":
    case "subagent.updated":
      return true;
    case "turn-item.updated":
      return turnItemUpdateCanEndBackgroundWork(event.payload);
    default:
      return isThreadPayloadEvent(event);
  }
}

function errorDetail(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    const nested = (cause as { readonly cause?: unknown }).cause;
    if (typeof nested === "string") return nested;
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The archive request could not be completed.";
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const newCommandId = (prefix: string, threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${prefix}:${threadId}:${uuid}`)),
    );

  const status = (threadId: ThreadId, operation: ThreadArchiveSchedulerError["operation"]) =>
    threads.getThreadRecords(threadId, []).pipe(
      Effect.map(({ thread }): ThreadArchiveStatus => ({
        archivedAt: thread.archivedAt,
        request: thread.archiveRequest ?? null,
      })),
      Effect.mapError(
        (cause) =>
          new ThreadArchiveSchedulerError({ operation, threadId, detail: errorDetail(cause) }),
      ),
    );

  const dispatch = (
    operation: ThreadArchiveSchedulerError["operation"],
    threadId: ThreadId,
    command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
  ) =>
    threads
      .dispatch(command)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadArchiveSchedulerError({ operation, threadId, detail: errorDetail(cause) }),
        ),
      );

  // Threads whose latest known state has a pending request; events on other
  // threads never cost a read.
  const tracked = new Set<ThreadId>();
  const queued = new Set<ThreadId>();

  const process = Effect.fn("ThreadArchiveScheduler.process")(function* (threadId: ThreadId) {
    const { thread, runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
    const request = pendingArchiveRequest(thread);
    if (request === null) {
      tracked.delete(threadId);
      return;
    }
    tracked.add(threadId);
    const shell = yield* threads.getThreadShell(threadId);
    const decision = evaluateDeferredArchive({
      thread,
      request,
      runs,
      pendingBackgroundTasks: shell?.pendingBackgroundTasks ?? [],
    });
    if (decision.type === "wait") return;
    yield* threads.dispatch({
      type: "thread.archive.execute",
      commandId: yield* newCommandId("archive-execute", threadId),
      threadId,
      requestId: request.requestId,
    });
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(
      Effect.andThen(process(threadId)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("deferred archive check failed", {
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
      if (pendingArchiveRequest(event.payload) === null) {
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

  const reconcilePending = threads.getShellSnapshot({ location: "active" }).pipe(
    Effect.flatMap((snapshot) =>
      Effect.forEach(
        snapshot.threads.filter((thread) => thread.archiveRequest?.status === "pending"),
        (thread) => enqueue(thread.id),
        { discard: true },
      ),
    ),
    Effect.catch((cause) => Effect.logWarning("deferred archive recovery failed", { cause })),
    Effect.andThen(worker.drain),
  );

  return ThreadArchiveScheduler.of({
    schedule: (input) =>
      Effect.gen(function* () {
        yield* dispatch("schedule", input.threadId, {
          type: "thread.archive.schedule",
          commandId: input.commandId ?? (yield* newCommandId("archive-schedule", input.threadId)),
          threadId: input.threadId,
          afterTurn: input.afterTurn,
        });
        return yield* status(input.threadId, "schedule");
      }),
    status: (threadId) => status(threadId, "status"),
    cancel: (input) =>
      Effect.gen(function* () {
        const current = yield* status(input.threadId, "cancel");
        if (current.archivedAt !== null || current.request?.status !== "pending") return current;
        yield* dispatch("cancel", input.threadId, {
          type: "thread.archive.cancel",
          commandId: input.commandId ?? (yield* newCommandId("archive-cancel", input.threadId)),
          threadId: input.threadId,
        });
        return yield* status(input.threadId, "cancel");
      }),
    start: Effect.fn("ThreadArchiveScheduler.start")(function* () {
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, onEvent).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("deferred archive event stream failed", { cause }),
          ),
        ),
      );
      yield* forkParked(reconcilePending);
    }),
    reconcilePending,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(ThreadArchiveScheduler, make);

/** Starts the deferred archive worker with the server. */
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* ThreadArchiveScheduler;
    yield* scheduler.start();
  }),
);
