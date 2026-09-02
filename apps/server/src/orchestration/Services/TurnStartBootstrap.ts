import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ThreadId,
} from "@t3tools/contracts";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "./ThreadDeletionReactor.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
type DispatchOptions = Parameters<OrchestrationEngine.OrchestrationEngineShape["dispatch"]>[1];

function unexpectedSetupScriptError(error: never): never {
  throw new Error(`Unhandled setup script error: ${String(error)}`);
}

/** Preserve the setup runner's broader pre-refactor message normalization. */
function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedSetupScriptError(error);
  }
}

/**
 * Runs a `thread.turn.start` command's optional bootstrap program: create the
 * thread, prepare a fresh worktree, run the project setup script, then start
 * the turn — deleting the created thread when a later step fails. Shared by
 * the WebSocket dispatch path and the HTTP dispatch route so both transports
 * honor bootstrap payloads identically.
 */
export class TurnStartBootstrap extends Context.Service<
  TurnStartBootstrap,
  {
    readonly dispatchTurnStart: (
      command: ThreadTurnStartCommand,
      options?: DispatchOptions,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  }
>()("t3/orchestration/Services/TurnStartBootstrap") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationDispatchCommandError({
          message: "Failed to generate orchestration command identifier.",
          cause,
        }),
    ),
  );
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const appendSetupScriptActivity = (
    input: {
      readonly threadId: ThreadId;
      readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
      readonly summary: string;
      readonly createdAt: string;
      readonly payload: Record<string, unknown>;
      readonly tone: "info" | "error";
    },
    options?: DispatchOptions,
  ) =>
    Effect.all({
      commandId: serverCommandId("setup-script-activity"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch(
          {
            type: "thread.activity.append",
            commandId,
            threadId: input.threadId,
            activity: {
              id: activityId,
              tone: input.tone,
              kind: input.kind,
              summary: input.summary,
              payload: input.payload,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          },
          options,
        ),
      ),
    );

  const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    return isOrchestrationDispatchCommandError(error)
      ? error
      : new OrchestrationDispatchCommandError({
          message:
            error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
          cause,
        });
  };

  const resolveDefaultWorktreeBaseBranch = (projectCwd: string) =>
    gitWorkflow.localStatus({ cwd: projectCwd }).pipe(
      Effect.flatMap((status) =>
        status.refName !== null
          ? Effect.succeed(status.refName)
          : Effect.fail(
              new OrchestrationDispatchCommandError({
                message:
                  "Could not resolve the project's current branch to base the new worktree on. Pass an explicit base branch.",
              }),
            ),
      ),
    );

  const dispatchTurnStart = (
    command: ThreadTurnStartCommand,
    options?: DispatchOptions,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
    Effect.gen(function* () {
      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      let createdThread = false;
      let createdWorktree: { readonly cwd: string; readonly path: string } | null = null;
      const targetProjectId = bootstrap?.createThread?.projectId;
      const targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

      const cleanupCreatedThread = () =>
        createdThread
          ? serverCommandId("bootstrap-thread-delete").pipe(
              Effect.flatMap((commandId) =>
                orchestrationEngine.dispatch(
                  {
                    type: "thread.delete",
                    commandId,
                    threadId: command.threadId,
                  },
                  options,
                ),
              ),
              Effect.as(true),
            )
          : Effect.succeed(false);

      // Only when this bootstrap also created the thread: a prepareWorktree-only
      // bootstrap runs against a pre-existing thread whose metadata may already
      // reference the new worktree, so it must survive a failed turn start.
      const cleanupCreatedWorktree = () =>
        createdThread && createdWorktree !== null
          ? gitWorkflow
              .removeWorktree({
                cwd: createdWorktree.cwd,
                path: createdWorktree.path,
                force: true,
              })
              .pipe(Effect.ignoreCause({ log: true }))
          : Effect.void;

      const recordSetupScriptLaunchFailure = (input: {
        readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
        readonly requestedAt: string;
        readonly worktreePath: string;
      }) => {
        const detail = projectSetupScriptCompatibilityDetail(input.error);
        return appendSetupScriptActivity(
          {
            threadId: command.threadId,
            kind: "setup-script.failed",
            summary: "Setup script failed to start",
            createdAt: input.requestedAt,
            payload: {
              detail,
              worktreePath: input.worktreePath,
            },
            tone: "error",
          },
          options,
        ).pipe(
          Effect.ignoreCause({ log: false }),
          Effect.flatMap(() =>
            Effect.logWarning("bootstrap turn start failed to launch setup script", {
              threadId: command.threadId,
              worktreePath: input.worktreePath,
              detail,
            }),
          ),
        );
      };

      const recordSetupScriptStarted = (input: {
        readonly requestedAt: string;
        readonly worktreePath: string;
        readonly scriptId: string;
        readonly scriptName: string;
        readonly terminalId: string;
      }) =>
        Effect.gen(function* () {
          const startedAt = yield* nowIso;
          const payload = {
            scriptId: input.scriptId,
            scriptName: input.scriptName,
            terminalId: input.terminalId,
            worktreePath: input.worktreePath,
          };
          yield* Effect.all([
            appendSetupScriptActivity(
              {
                threadId: command.threadId,
                kind: "setup-script.requested",
                summary: "Starting setup script",
                createdAt: input.requestedAt,
                payload,
                tone: "info",
              },
              options,
            ),
            appendSetupScriptActivity(
              {
                threadId: command.threadId,
                kind: "setup-script.started",
                summary: "Setup script started",
                createdAt: startedAt,
                payload,
                tone: "info",
              },
              options,
            ),
          ]).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning(
                "bootstrap turn start launched setup script but failed to record setup activity",
                {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  scriptId: input.scriptId,
                  terminalId: input.terminalId,
                  detail: error.message,
                },
              ),
            ),
          );
        });

      const runSetupProgram = () =>
        Effect.gen(function* () {
          if (!bootstrap?.runSetupScript || !targetWorktreePath) {
            return;
          }
          const worktreePath = targetWorktreePath;
          const requestedAt = yield* nowIso;
          yield* projectSetupScriptRunner
            .runForThread({
              threadId: command.threadId,
              ...(targetProjectId ? { projectId: targetProjectId } : {}),
              ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
              worktreePath,
            })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  recordSetupScriptLaunchFailure({
                    error,
                    requestedAt,
                    worktreePath,
                  }),
                onSuccess: (setupResult) => {
                  if (setupResult.status !== "started") {
                    return Effect.void;
                  }
                  return recordSetupScriptStarted({
                    requestedAt,
                    worktreePath,
                    scriptId: setupResult.scriptId,
                    scriptName: setupResult.scriptName,
                    terminalId: setupResult.terminalId,
                  });
                },
              }),
            );
        });

      const bootstrapProgram = Effect.gen(function* () {
        if (bootstrap?.createThread) {
          const created = yield* orchestrationEngine.dispatch(
            {
              type: "thread.create",
              commandId: yield* serverCommandId("bootstrap-thread-create"),
              threadId: command.threadId,
              projectId: bootstrap.createThread.projectId,
              title: bootstrap.createThread.title,
              modelSelection: bootstrap.createThread.modelSelection,
              runtimeMode: bootstrap.createThread.runtimeMode,
              interactionMode: bootstrap.createThread.interactionMode,
              branch: bootstrap.createThread.branch,
              worktreePath: bootstrap.createThread.worktreePath,
              createdAt: bootstrap.createThread.createdAt,
            },
            options,
          );
          // The successful create is a fence in the engine command queue:
          // every delete for the prior incarnation committed before it.
          // Drain through that event before setup or turn start can own
          // terminals and provider sessions under the reused thread id.
          yield* threadDeletionReactor.drainThrough(created.sequence);
          createdThread = true;
        }

        if (bootstrap?.prepareWorktree) {
          const baseBranch =
            bootstrap.prepareWorktree.baseBranch ??
            (yield* resolveDefaultWorktreeBaseBranch(bootstrap.prepareWorktree.projectCwd));
          let worktreeBaseRef = baseBranch;
          // "Start from origin" is a stored default; repos without an origin
          // remote fall back to the local base branch instead of failing the
          // whole bootstrap on `git fetch origin`.
          const startFromOrigin =
            bootstrap.prepareWorktree.startFromOrigin === true &&
            (yield* gitWorkflow.remoteExists({
              cwd: bootstrap.prepareWorktree.projectCwd,
              remoteName: "origin",
            }));
          if (startFromOrigin) {
            yield* gitWorkflow.fetchRemote({
              cwd: bootstrap.prepareWorktree.projectCwd,
              remoteName: "origin",
            });
            // A local-only base branch has nothing to resolve on the remote;
            // fall back to the local ref instead of failing the bootstrap.
            const remoteBaseExists = yield* gitWorkflow.remoteBranchExists({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: baseBranch,
              remoteName: "origin",
            });
            if (remoteBaseExists) {
              const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: baseBranch,
                fallbackRemoteName: "origin",
              });
              worktreeBaseRef = resolvedRemoteBase.commitSha;
            }
          }
          const worktree = yield* gitWorkflow.createWorktree({
            cwd: bootstrap.prepareWorktree.projectCwd,
            refName: worktreeBaseRef,
            newRefName: bootstrap.prepareWorktree.branch,
            baseRefName: baseBranch,
            path: null,
          });
          targetWorktreePath = worktree.worktree.path;
          createdWorktree = {
            cwd: bootstrap.prepareWorktree.projectCwd,
            path: worktree.worktree.path,
          };
          yield* orchestrationEngine.dispatch(
            {
              type: "thread.meta.update",
              commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
              threadId: command.threadId,
              branch: worktree.worktree.refName,
              worktreePath: targetWorktreePath,
            },
            options,
          );
          yield* refreshGitStatus(targetWorktreePath);
        }

        yield* runSetupProgram();

        return yield* orchestrationEngine.dispatch(finalTurnStartCommand, options);
      });

      return yield* bootstrapProgram.pipe(
        Effect.catchCause((cause) => {
          const dispatchError = toBootstrapDispatchCommandCauseError(cause);
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.fail(dispatchError);
          }
          // Uninterruptible so a client disconnect mid-cleanup cannot leave a
          // half-deleted thread; a successful delete is reported to the client
          // so it can retry the bootstrap with a fresh thread id.
          return Effect.uninterruptible(
            cleanupCreatedThread().pipe(
              Effect.matchCauseEffect({
                onFailure: (cleanupCause) =>
                  Effect.logWarning("bootstrap thread cleanup failed", {
                    threadId: command.threadId,
                    detail: Cause.pretty(cleanupCause),
                  }).pipe(
                    Effect.flatMap(() => cleanupCreatedWorktree()),
                    Effect.flatMap(() => Effect.fail(dispatchError)),
                  ),
                onSuccess: (threadDeleted) =>
                  cleanupCreatedWorktree().pipe(
                    Effect.flatMap(() =>
                      Effect.fail(
                        threadDeleted
                          ? new OrchestrationDispatchCommandError({
                              message: dispatchError.message,
                              ...(dispatchError.cause !== undefined
                                ? { cause: dispatchError.cause }
                                : {}),
                              bootstrapThreadDisposition: "deleted",
                            })
                          : dispatchError,
                      ),
                    ),
                  ),
              }),
            ),
          );
        }),
      );
    });

  return TurnStartBootstrap.of({ dispatchTurnStart });
});

export const layer = Layer.effect(TurnStartBootstrap, make);
