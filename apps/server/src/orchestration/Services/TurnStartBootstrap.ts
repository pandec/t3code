import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { ProjectionSnapshotQuery } from "./ProjectionSnapshotQuery.ts";
import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ProjectId,
  type ThreadId,
  WORKTREE_SETUP_ACTIVITY_KIND,
  worktreeSetupActivityId,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "./ThreadDeletionReactor.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { ServerSettingsService } from "../../serverSettings.ts";

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
  const query = yield* ProjectionSnapshotQuery;
  const worktreeSetupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const serverSettings = yield* ServerSettingsService;

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

  // Project > environment. Null leaves the policy to the newly checked-out
  // branch's t3.json, which is unavailable until createWorktree has run.
  const resolveBootstrapWorktreeSubmodules = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId | null;
  }) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) return null;
    const projectId =
      input.projectId ??
      (yield* query.getThreadShellById(input.threadId).pipe(
        Effect.map((thread) => Option.getOrNull(thread)?.projectId ?? null),
        Effect.orElseSucceed(() => null),
      ));
    const project =
      projectId === null
        ? null
        : yield* query.getProjectShellById(projectId).pipe(
            Effect.map(Option.getOrNull),
            Effect.orElseSucceed(() => null),
          );
    return resolveProjectSettings(settings, projectId, project).settings.worktreeSubmodules;
  });

  const dispatchTurnStart = (
    command: ThreadTurnStartCommand,
    options?: DispatchOptions,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
    Effect.gen(function* () {
      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      const dispatchFromClient = (input: OrchestrationCommand) =>
        orchestrationEngine.dispatch(input, options);
      const recordWorktreeSetup = (snapshot: WorktreeSetupSnapshot) =>
        requireCurrentThread.pipe(Effect.andThen(serverCommandId("worktree-setup-activity"))).pipe(
          Effect.flatMap((commandId) =>
            dispatchFromClient({
              type: "thread.activity.append",
              commandId,
              threadId: snapshot.threadId,
              activity: {
                id: EventId.make(worktreeSetupActivityId(snapshot.threadId)),
                tone:
                  snapshot.phase === "failed" ||
                  snapshot.stages.some((stage) => stage.status === "failed")
                    ? "error"
                    : "info",
                kind: WORKTREE_SETUP_ACTIVITY_KIND,
                summary:
                  snapshot.phase === "running"
                    ? "Setting up worktree"
                    : snapshot.phase === "done"
                      ? "Worktree ready"
                      : snapshot.phase === "cancelled"
                        ? "Worktree setup cancelled"
                        : "Worktree setup failed",
                payload: snapshot,
                turnId: null,
                createdAt: snapshot.startedAt,
              },
              createdAt: snapshot.endedAt ?? snapshot.startedAt,
            }),
          ),
          Effect.ignoreCause({ log: true }),
        );
      let setupTerminalId: string | null = null;
      let createdThread = false;
      let expectedCreatedAt: string | undefined;
      let staleThread = false;
      let setupCompletionFiber: Fiber.Fiber<void, never> | null = null;
      const threadStillCurrent = Effect.gen(function* () {
        const current = yield* query.getThreadShellById(command.threadId);
        return (
          Option.isSome(current) &&
          current.value.archivedAt === null &&
          (expectedCreatedAt === undefined || current.value.createdAt === expectedCreatedAt)
        );
      });
      const requireCurrentThread = Effect.gen(function* () {
        if (yield* threadStillCurrent) return;
        staleThread = true;
        return yield* new OrchestrationDispatchCommandError({
          message: "Worktree setup stopped because the thread was archived, deleted, or replaced.",
        });
      });
      const whileThreadCurrent = (effect: Effect.Effect<void>) =>
        threadStillCurrent.pipe(
          Effect.flatMap((current) => (current ? effect : Effect.void)),
          Effect.ignoreCause({ log: true }),
        );
      let createdWorktree: { readonly cwd: string; readonly path: string } | null = null;
      const targetProjectId = bootstrap?.createThread?.projectId;
      const targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

      // Set once the checkout starts; see the session.set below.
      let preparingSessionSet = false;
      const markPreparingSessionFailed = (detail: string) =>
        Effect.gen(function* () {
          const failedAt = yield* nowIso;
          yield* dispatchFromClient({
            type: "thread.session.set",
            commandId: yield* serverCommandId("bootstrap-thread-preparing-failed"),
            threadId,
            session: {
              threadId,
              status: "error",
              providerName: null,
              providerInstanceId:
                bootstrap?.createThread?.modelSelection.instanceId ??
                command.modelSelection?.instanceId,
              runtimeMode: command.runtimeMode,
              activeTurnId: null,
              lastError: detail.trim().length > 0 ? detail : "Worktree setup failed.",
              updatedAt: failedAt,
            },
            createdAt: failedAt,
          });
        });
      const cleanupCreatedThread = () =>
        createdThread && !staleThread
          ? requireCurrentThread
              .pipe(Effect.andThen(serverCommandId("bootstrap-thread-delete")))
              .pipe(
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
        createdThread && !staleThread && createdWorktree !== null
          ? gitWorkflow
              .removeWorktree({
                cwd: createdWorktree.cwd,
                path: createdWorktree.path,
                force: true,
              })
              .pipe(
                Effect.retry({ times: 4, schedule: Schedule.spaced("500 millis") }),
                Effect.ignoreCause({ log: true }),
              )
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

      const tracked = bootstrap?.prepareWorktree !== undefined;
      const threadId = command.threadId;
      const track = (effect: Effect.Effect<void>) => (tracked ? effect : Effect.void);

      // Starts the setup script. For tracked bootstraps it returns the
      // effect that waits for the script to exit and records the outcome
      // on the card; whether the agent stage waits on it depends on the
      // script's `async` flag. Returns null when nothing is left to await.
      // Untracked callers keep the old fire-and-forget behavior.
      const runSetupProgram = () =>
        Effect.gen(function* () {
          if (!bootstrap?.runSetupScript || !targetWorktreePath) {
            yield* track(worktreeSetupTracker.stageStatus(threadId, "setup-script", "skipped"));
            return null;
          }
          const worktreePath = targetWorktreePath;
          const requestedAt = yield* nowIso;
          yield* track(worktreeSetupTracker.stageStatus(threadId, "setup-script", "running"));
          const setupResult = yield* projectSetupScriptRunner
            .runForThread({
              threadId,
              ...(targetProjectId ? { projectId: targetProjectId } : {}),
              ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
              worktreePath,
              ...(tracked
                ? {
                    observeCompletion: {
                      onOutputLine: (line) =>
                        worktreeSetupTracker.appendTail(threadId, "setup-script", line),
                    },
                  }
                : {}),
            })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  recordSetupScriptLaunchFailure({
                    error,
                    requestedAt,
                    worktreePath,
                  }).pipe(
                    Effect.andThen(
                      track(
                        worktreeSetupTracker.stageStatus(
                          threadId,
                          "setup-script",
                          "failed",
                          "failed to start",
                        ),
                      ),
                    ),
                    Effect.as(null),
                  ),
                onSuccess: (setupResult) => {
                  if (setupResult.status !== "started") {
                    return track(
                      worktreeSetupTracker.stageStatus(
                        threadId,
                        "setup-script",
                        "skipped",
                        "no setup script",
                      ),
                    ).pipe(Effect.as(null));
                  }
                  setupTerminalId = setupResult.terminalId;
                  return recordSetupScriptStarted({
                    requestedAt,
                    worktreePath,
                    scriptId: setupResult.scriptId,
                    scriptName: setupResult.scriptName,
                    terminalId: setupResult.terminalId,
                  }).pipe(
                    Effect.andThen(
                      track(
                        worktreeSetupTracker.update(threadId, (snapshot) => ({
                          ...snapshot,
                          setupScript: {
                            name: setupResult.scriptName,
                            command: setupResult.scriptCommand,
                            terminalId: setupResult.terminalId,
                          },
                        })),
                      ),
                    ),
                    Effect.as(setupResult),
                  );
                },
              }),
            );
          if (!tracked || !setupResult?.completion) {
            return null;
          }
          // The setup script is best effort, like the untracked path: a
          // failed install must not throw away the worktree the user just
          // waited for. The card keeps the failed stage and its terminal.
          // Forked right away so the terminal listener behind `completion`
          // is always consumed, even when the turn dispatch fails before
          // anyone would otherwise wait on it. The tracker update is a
          // no-op once the snapshot has been dropped.
          const completionFiber = yield* setupResult.completion.pipe(
            Effect.flatMap((completion) => {
              if (completion.exitCode === 0) {
                return whileThreadCurrent(
                  worktreeSetupTracker.stageStatus(threadId, "setup-script", "done"),
                );
              }
              const detail =
                completion.exitCode === null
                  ? "terminal closed before the script finished"
                  : `exit ${completion.exitCode}`;
              return whileThreadCurrent(
                worktreeSetupTracker.stageStatus(threadId, "setup-script", "failed", detail),
              );
            }),
            Effect.forkDetach,
          );
          setupCompletionFiber = completionFiber;
          if (!setupResult.async) {
            yield* Fiber.join(completionFiber);
            return null;
          }
          return completionFiber;
        });

      const bootstrapProgram = Effect.gen(function* () {
        if (bootstrap?.createThread) {
          const created = yield* dispatchFromClient({
            type: "thread.create",
            ...(bootstrap.createThread.customGroupId !== undefined
              ? { customGroupId: bootstrap.createThread.customGroupId }
              : {}),
            commandId: yield* serverCommandId("bootstrap-thread-create"),
            threadId: command.threadId,
            projectId: bootstrap.createThread.projectId,
            title: bootstrap.createThread.title,
            ...(bootstrap.createThread.titleSource
              ? { titleSource: bootstrap.createThread.titleSource }
              : {}),
            modelSelection: bootstrap.createThread.modelSelection,
            runtimeMode: bootstrap.createThread.runtimeMode,
            interactionMode: bootstrap.createThread.interactionMode,
            branch: bootstrap.createThread.branch,
            worktreePath: bootstrap.createThread.worktreePath,
            createdAt: bootstrap.createThread.createdAt,
          });
          // The successful create is a fence in the engine command queue:
          // every delete for the prior incarnation committed before it.
          // Drain through that event before setup or turn start can own
          // terminals and provider sessions under the reused thread id.
          yield* threadDeletionReactor.drainThrough(created.sequence);
          createdThread = true;
          expectedCreatedAt = bootstrap.createThread.createdAt;
          yield* dispatchFromClient({
            type: "thread.message.user.append",
            commandId: yield* serverCommandId("bootstrap-thread-message"),
            threadId,
            message: {
              messageId: command.message.messageId,
              text: command.message.text,
              attachments: command.message.attachments,
              ...(command.message.context !== undefined
                ? { context: command.message.context }
                : {}),
              ...(command.message.inputOrigin !== undefined
                ? { inputOrigin: command.message.inputOrigin }
                : {}),
            },
            createdAt: command.createdAt,
          });
          if (tracked) {
            const running = yield* worktreeSetupTracker.get(threadId);
            if (running) yield* recordWorktreeSetup(running);
          }
        }

        if (!bootstrap?.createThread && bootstrap) {
          const current = yield* query.getThreadShellById(threadId);
          if (Option.isSome(current)) expectedCreatedAt = current.value.createdAt;
          yield* requireCurrentThread;
        }
        const prepareWorktree = bootstrap?.prepareWorktree;
        let shouldPrepareWorktree = prepareWorktree
          ? yield* gitWorkflow.isRepository(prepareWorktree.projectCwd)
          : false;
        const baseBranch =
          prepareWorktree && shouldPrepareWorktree
            ? (prepareWorktree.baseBranch ??
              (yield* resolveDefaultWorktreeBaseBranch(prepareWorktree.projectCwd)))
            : null;
        let worktreeBaseRef = baseBranch;

        if (prepareWorktree && shouldPrepareWorktree && baseBranch) {
          // "Start from origin" is a stored default; repos without the
          // requested remote branch fall back to the local base branch.
          const startFromOrigin =
            prepareWorktree.startFromOrigin === true &&
            (yield* gitWorkflow.remoteExists({
              cwd: prepareWorktree.projectCwd,
              remoteName: "origin",
            }));
          if (startFromOrigin) {
            yield* track(worktreeSetupTracker.stageStatus(threadId, "fetch", "running"));
            yield* gitWorkflow.fetchRemote({
              cwd: prepareWorktree.projectCwd,
              remoteName: "origin",
              refName: baseBranch,
            });
            const remoteBaseExists = yield* gitWorkflow.remoteBranchExists({
              cwd: prepareWorktree.projectCwd,
              refName: baseBranch,
              remoteName: "origin",
            });
            if (remoteBaseExists) {
              const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                cwd: prepareWorktree.projectCwd,
                refName: baseBranch,
                fallbackRemoteName: "origin",
              });
              worktreeBaseRef = resolvedRemoteBase.commitSha;
              yield* track(
                worktreeSetupTracker.stageStatus(
                  threadId,
                  "fetch",
                  "done",
                  `origin/${baseBranch} at ${resolvedRemoteBase.commitSha.slice(0, 7)}`,
                ),
              );
            } else {
              yield* track(
                worktreeSetupTracker.stageStatus(
                  threadId,
                  "fetch",
                  "warning",
                  `origin/${baseBranch} not found, using local branch`,
                ),
              );
            }
          } else {
            yield* track(worktreeSetupTracker.stageStatus(threadId, "fetch", "skipped"));
          }

          const resolvedWorktreeBaseRef = worktreeBaseRef ?? baseBranch;
          shouldPrepareWorktree = yield* gitWorkflow.hasCommit({
            cwd: prepareWorktree.projectCwd,
            refName: resolvedWorktreeBaseRef,
          });
          worktreeBaseRef = resolvedWorktreeBaseRef;
          yield* track(
            worktreeSetupTracker.update(threadId, (snapshot) => ({
              ...snapshot,
              baseRef: resolvedWorktreeBaseRef,
            })),
          );
        }

        if (prepareWorktree && !shouldPrepareWorktree) {
          if (prepareWorktree.requireWorktree) {
            return yield* new OrchestrationDispatchCommandError({
              message:
                "A separate worktree requires a Git repository and a base branch with a commit.",
            });
          }
          // Not a git repo, or the base has no commit: the thread runs in
          // the project checkout instead. The card says so and moves on.
          yield* track(
            worktreeSetupTracker.update(threadId, (snapshot) => ({
              ...snapshot,
              stages: snapshot.stages.map((stage) =>
                stage.id === "fetch" || stage.id === "checkout" || stage.id === "submodules"
                  ? { ...stage, status: "skipped", detail: "using project checkout" }
                  : stage,
              ),
            })),
          );
        }

        if (prepareWorktree && shouldPrepareWorktree && worktreeBaseRef && baseBranch) {
          if (bootstrap?.createThread && createdThread) {
            // The checkout and setup script can run for minutes before the
            // turn starts. Project a starting session alongside the saved
            // prompt so clients list the thread as working and follow its
            // setup stream when reopened.
            yield* requireCurrentThread;
            const preparingAt = yield* nowIso;
            yield* dispatchFromClient({
              type: "thread.session.set",
              commandId: yield* serverCommandId("bootstrap-thread-preparing"),
              threadId,
              session: {
                threadId,
                status: "starting",
                providerName: null,
                providerInstanceId: bootstrap.createThread.modelSelection.instanceId,
                runtimeMode: command.runtimeMode,
                activeTurnId: null,
                lastError: null,
                updatedAt: preparingAt,
              },
              createdAt: preparingAt,
            });
            preparingSessionSet = true;
          }
          yield* worktreeSetupTracker.stageStatus(threadId, "checkout", "running");
          let checkoutTotal: number | null = null;
          const submodules = yield* resolveBootstrapWorktreeSubmodules({
            threadId,
            projectId: targetProjectId ?? null,
          });
          const worktree = yield* gitWorkflow.createWorktree(
            {
              cwd: prepareWorktree.projectCwd,
              refName: worktreeBaseRef,
              newRefName: prepareWorktree.branch,
              baseRefName: baseBranch,
              path: null,
            },
            {
              submodules,
              progress: {
                // Git has registered the directory at this point, so a
                // cancel during the submodule step can still remove it.
                onWorktreeClaimed: (path) =>
                  Effect.sync(() => {
                    targetWorktreePath = path;
                    createdWorktree = { cwd: prepareWorktree.projectCwd, path };
                  }),
                onCheckoutProgress: ({ percent, completed, total }) => {
                  checkoutTotal = total;
                  return worktreeSetupTracker.stage(threadId, "checkout", {
                    percent,
                    detail: `${completed.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} files`,
                  });
                },
                onSubmodulesStarted: () =>
                  worktreeSetupTracker
                    .stageStatus(
                      threadId,
                      "checkout",
                      "done",
                      checkoutTotal === null
                        ? null
                        : `${checkoutTotal.toLocaleString("en-US")} files`,
                    )
                    .pipe(
                      Effect.andThen(
                        worktreeSetupTracker.stageStatus(threadId, "submodules", "running"),
                      ),
                    ),
                onSubmodulesDisabled: () =>
                  worktreeSetupTracker.stageStatus(threadId, "submodules", "skipped", "disabled"),
                onSubmoduleLine: (line) => {
                  const submodulePath = /Submodule path '([^']+)'/.exec(line)?.[1];
                  return submodulePath === undefined
                    ? Effect.void
                    : worktreeSetupTracker.stage(threadId, "submodules", {
                        detail: submodulePath,
                      });
                },
                onSubmodulesFinished: ({ ok, detail }) =>
                  worktreeSetupTracker.stageStatus(
                    threadId,
                    "submodules",
                    ok ? "done" : "warning",
                    ok ? undefined : (detail ?? "submodule checkout failed"),
                  ),
              },
            },
          );
          const checkoutEndedAt = yield* nowIso;
          yield* worktreeSetupTracker.update(threadId, (snapshot) => ({
            ...snapshot,
            worktreePath: worktree.worktree.path,
            stages: snapshot.stages.map((stage) => {
              if (stage.id === "checkout" && stage.status === "running") {
                return {
                  ...stage,
                  status: "done",
                  percent: 100,
                  endedAt: checkoutEndedAt,
                  detail:
                    checkoutTotal === null
                      ? stage.detail
                      : `${checkoutTotal.toLocaleString("en-US")} files`,
                };
              }
              if (stage.id === "submodules" && stage.status === "pending") {
                return { ...stage, status: "skipped", detail: "none" };
              }
              return stage;
            }),
          }));
          targetWorktreePath = worktree.worktree.path;
          createdWorktree = { cwd: prepareWorktree.projectCwd, path: targetWorktreePath };
          yield* requireCurrentThread;
          yield* dispatchFromClient({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
            threadId,
            branch: worktree.worktree.refName,
            worktreePath: targetWorktreePath,
          });
          yield* refreshGitStatus(targetWorktreePath);
        }

        if (bootstrap) yield* requireCurrentThread;
        const pendingSetupScript = yield* runSetupProgram();
        if (bootstrap) yield* requireCurrentThread;

        yield* track(worktreeSetupTracker.stageStatus(threadId, "agent", "running"));
        // Past this point a cancel would roll back a thread whose turn has
        // started. Drop the cancel handle and make the handoff atomic.
        const started = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* track(worktreeSetupTracker.markUncancellable(threadId));
            return yield* dispatchFromClient(finalTurnStartCommand);
          }),
        );
        yield* track(worktreeSetupTracker.stageStatus(threadId, "agent", "done"));
        // An async setup script outlives the handoff: the snapshot stays
        // running so the client keeps its row next to the agent's work,
        // and settles when the script exits. The turn already started, so
        // the wait cannot fail the dispatch.
        const settle = tracked
          ? worktreeSetupTracker
              .finish(threadId, "done")
              .pipe(
                Effect.flatMap((snapshot) =>
                  snapshot ? recordWorktreeSetup(snapshot) : Effect.void,
                ),
              )
          : Effect.void;
        if (pendingSetupScript) {
          const running = yield* worktreeSetupTracker.get(threadId);
          if (running) yield* recordWorktreeSetup(running);
          yield* Fiber.join(pendingSetupScript).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.andThen(whileThreadCurrent(settle)),
            Effect.forkDetach,
          );
        } else {
          yield* settle;
        }
        return started;
      });

      const cleanupAndFail = (dispatchError: OrchestrationDispatchCommandError) => {
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
                  Effect.andThen(
                    preparingSessionSet && !staleThread
                      ? markPreparingSessionFailed(dispatchError.message).pipe(
                          Effect.ignoreCause({ log: true }),
                        )
                      : Effect.void,
                  ),
                  Effect.flatMap(() => cleanupCreatedWorktree()),
                  Effect.flatMap(() => Effect.fail(dispatchError)),
                ),
              onSuccess: (threadDeleted) =>
                cleanupCreatedWorktree().pipe(
                  Effect.flatMap(() =>
                    Effect.fail(
                      threadDeleted ||
                        (bootstrap?.createThread &&
                          bootstrap.prepareWorktree?.requireWorktree === true &&
                          !createdThread)
                        ? new OrchestrationDispatchCommandError({
                            message: dispatchError.message,
                            ...(dispatchError.cause !== undefined
                              ? { cause: dispatchError.cause }
                              : {}),
                            bootstrapThreadDisposition: threadDeleted ? "deleted" : "not-created",
                          })
                        : dispatchError,
                    ),
                  ),
                ),
            }),
          ),
        );
      };

      const settledBootstrapProgram = Effect.uninterruptibleMask((restore) =>
        restore(bootstrapProgram).pipe(
          Effect.interruptible,
          Effect.onError(() =>
            setupCompletionFiber
              ? Fiber.interrupt(setupCompletionFiber).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.catchCause((cause) => {
            const dispatchError = toBootstrapDispatchCommandCauseError(cause);
            if (Cause.hasInterruptsOnly(cause)) {
              if (!tracked) return Effect.fail(dispatchError);
              const closeSetupTerminal = setupTerminalId
                ? terminalManager.close({
                    threadId,
                    terminalId: setupTerminalId,
                    deleteHistory: true,
                  })
                : Effect.void;
              return Effect.uninterruptible(
                closeSetupTerminal.pipe(
                  Effect.ignoreCause({ log: true }),
                  Effect.andThen(
                    worktreeSetupTracker
                      .finish(threadId, "cancelled")
                      .pipe(
                        Effect.flatMap((snapshot) =>
                          snapshot ? recordWorktreeSetup(snapshot) : Effect.void,
                        ),
                      ),
                  ),
                  Effect.andThen(
                    cleanupAndFail(
                      new OrchestrationDispatchCommandError({
                        message: "Worktree setup cancelled.",
                      }),
                    ),
                  ),
                ),
              );
            }
            return track(
              worktreeSetupTracker
                .finish(threadId, "failed", dispatchError.message)
                .pipe(
                  Effect.flatMap((snapshot) =>
                    snapshot ? recordWorktreeSetup(snapshot) : Effect.void,
                  ),
                ),
            ).pipe(Effect.andThen(cleanupAndFail(dispatchError)));
          }),
        ),
      );
      if (!tracked) return yield* settledBootstrapProgram;
      const fiber = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkDetach(
            Deferred.await(ready).pipe(Effect.andThen(settledBootstrapProgram)),
          );
          yield* worktreeSetupTracker.begin({
            threadId,
            branch: bootstrap?.prepareWorktree?.branch ?? null,
            baseRef: bootstrap?.prepareWorktree?.baseBranch ?? null,
            stages: ["fetch", "checkout", "submodules", "setup-script", "agent"],
            fiber,
          });
          yield* Deferred.succeed(ready, undefined);
          return fiber;
        }),
      );
      return yield* Fiber.join(fiber);
    });

  return TurnStartBootstrap.of({ dispatchTurnStart });
});

export const layer = Layer.effect(TurnStartBootstrap, make);
