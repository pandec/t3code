import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ArchiveToolkitHandlersLive } from "./handlers.ts";
import { ArchiveToolkit } from "./tools.ts";

const threadId = ThreadId.make("own-thread");
const instanceId = ProviderInstanceId.make("claude");
const turnId = TurnId.make("turn");
const now = "2026-09-28T10:00:00.000Z";
const pendingRequest = {
  requestId: CommandId.make("archive-request"),
  turnId,
  removeWorktree: false,
  worktreePath: "/worktree",
  requestedAt: now,
  status: "pending" as const,
};
const thread: OrchestrationThreadShell = {
  id: threadId,
  projectId: ProjectId.make("project"),
  title: "Thread",
  modelSelection: { instanceId, model: "claude-sonnet-4-6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: "/worktree",
  pullRequests: [],
  latestTurn: {
    turnId,
    state: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    assistantMessageId: null,
  },
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: {
    threadId,
    status: "running",
    providerName: "claudeAgent",
    providerInstanceId: instanceId,
    runtimeMode: "full-access",
    activeTurnId: turnId,
    lastError: null,
    updatedAt: now,
  },
  latestUserMessageAt: now,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const handlersFor = (
  read: () => OrchestrationThreadShell | undefined,
  dispatch: OrchestrationEngineService["Service"]["dispatch"] = () =>
    Effect.die("Unexpected archive mutation"),
) =>
  ArchiveToolkitHandlersLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(McpInvocationContext, {
          threadId,
          environmentId: EnvironmentId.make("env"),
          providerSessionId: "session",
          providerInstanceId: instanceId,
          capabilities: new Set<never>(),
          issuedAt: 1,
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: (id, options) =>
            Effect.sync(() => {
              expect(id).toBe(threadId);
              expect(options?.includeArchived).toBe(true);
              return Option.fromNullishOr(read());
            }),
        }),
        Layer.mock(OrchestrationEngineService)({ dispatch }),
      ),
    ),
  );

it.effect.each([undefined, false, true])(
  "schedules only its own thread after the turn with removeWorktree=%s",
  (removeWorktree) => {
    let current = thread;
    const commands: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const toolkit = yield* ArchiveToolkit;
      const result = yield* toolkit
        .handle("archive_thread", removeWorktree === undefined ? {} : { removeWorktree })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(commands).toMatchObject([
        {
          type: "thread.archive.schedule",
          threadId,
          afterTurn: true,
          removeWorktree: removeWorktree ?? false,
        },
      ]);
      expect(result.at(-1)?.result).toEqual({ archivedAt: null, request: pendingRequest });
    }).pipe(
      Effect.provide(
        handlersFor(
          () => current,
          (command) =>
            Effect.sync(() => {
              commands.push(command);
              current = { ...thread, archiveRequest: pendingRequest };
              return { sequence: 1 };
            }),
        ),
      ),
    );
  },
);

it.effect.each(["archive_thread", "archive_thread_status", "cancel_thread_archive"] as const)(
  "%s rejects missing threads and stale provider ownership",
  (name) =>
    Effect.gen(function* () {
      for (const unavailable of [
        undefined,
        { ...thread, session: null },
        {
          ...thread,
          session: { ...thread.session!, providerInstanceId: ProviderInstanceId.make("other") },
        },
      ]) {
        const result = yield* Effect.gen(function* () {
          const toolkit = yield* ArchiveToolkit;
          return yield* toolkit
            .handle(name, {})
            .pipe(Stream.unwrap, Stream.runCollect, Effect.result);
        }).pipe(Effect.provide(handlersFor(() => unavailable)));
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ThreadArchiveError",
            message: unavailable
              ? "This provider no longer owns the thread."
              : "This thread no longer exists.",
          },
        });
      }
    }),
);

it.effect("reports cleanup failures even when the thread is already archived", () =>
  Effect.gen(function* () {
    const toolkit = yield* ArchiveToolkit;
    const result = yield* toolkit
      .handle("archive_thread_status", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toEqual({
      archivedAt: now,
      request: { ...pendingRequest, status: "error", detail: "Worktree is dirty." },
    });
  }).pipe(
    Effect.provide(
      handlersFor(() => ({
        ...thread,
        archivedAt: now,
        archiveRequest: { ...pendingRequest, status: "error", detail: "Worktree is dirty." },
      })),
    ),
  ),
);

it.effect.each([false, true])("cancels only pending requests, pending=%s", (pending) => {
  let current = { ...thread, archiveRequest: pending ? pendingRequest : null };
  const commands: OrchestrationCommand[] = [];
  return Effect.gen(function* () {
    const toolkit = yield* ArchiveToolkit;
    const result = yield* toolkit
      .handle("cancel_thread_archive", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(commands).toMatchObject(pending ? [{ type: "thread.archive.cancel", threadId }] : []);
    expect(result.at(-1)?.result).toEqual({ archivedAt: null, request: current.archiveRequest });
  }).pipe(
    Effect.provide(
      handlersFor(
        () => current,
        (command) =>
          Effect.sync(() => {
            commands.push(command);
            current = { ...thread, archiveRequest: null };
            return { sequence: 1 };
          }),
      ),
    ),
  );
});

it.effect("returns orchestration rejection details instead of claiming scheduling succeeded", () =>
  Effect.gen(function* () {
    const toolkit = yield* ArchiveToolkit;
    const result = yield* toolkit
      .handle("archive_thread", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ThreadArchiveError",
        message: expect.stringContaining("An archive is already pending."),
      },
    });
  }).pipe(
    Effect.provide(
      handlersFor(
        () => thread,
        () =>
          Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: "thread.archive.schedule",
              detail: "An archive is already pending.",
            }),
          ),
      ),
    ),
  ),
);
