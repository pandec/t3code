import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  type TerminalSummary,
  type ChatAttachment,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2DelegatedFrom,
  type OrchestrationV2WorkflowOrigin,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2WorkspacePreparation,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  ProjectId,
  type RunId,
  type RuntimeMode,
  type ScheduledTaskId,
  type GitManagerServiceError,
  TaskFolderError,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import {
  buildTemporaryWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  formatGeneratedBranchName,
  isTemporaryWorktreeBranch,
} from "@t3tools/shared/git";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { parseGitCloneProgressLine } from "../project/gitCloneProgress.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { readLiveProviderSessionCwds, storageCleanupWorktreeInUse } from "../storageCleanup.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  canonicalWorkspacePath,
  reserveWorkspace,
  withWorkspaceLease,
} from "../workspace/workspaceLease.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as Orchestrator from "./Orchestrator.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { reportLabel } from "@t3tools/provider-core/server/notification";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as LabsService from "../labs/LabsService.ts";
import { isSpLabWorktree } from "../labs/labWorktree.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";

// The agent waits for its branch name; a rate-limited provider would hold it for minutes.
const BRANCH_NAME_TIMEOUT = "20 seconds";

export type ThreadLaunchWorkspaceStrategy = OrchestrationV2WorkspacePreparation;

export interface ThreadLaunchInitialMessage {
  readonly messageId?: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: import("@t3tools/contracts").OrchestrationMessageContext | undefined;
  readonly inputOrigin?: import("@t3tools/contracts").MessageInputOrigin | undefined;
  /** Ask the first run for a result as data matching this JSON Schema. */
  readonly outputSchema?: Readonly<Record<string, Schema.Json>> | undefined;
}

export interface ThreadLaunchInput {
  readonly commandId: CommandId;
  readonly threadId?: ThreadId;
  readonly reuseExistingThread?: boolean;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly generateTitle?: boolean;
  /** The caller chose `title`, so a first message keeps it. */
  readonly titleRenamed?: boolean;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  readonly initialMessage?: ThreadLaunchInitialMessage;
  readonly importedNativeThread?: {
    readonly ref: {
      readonly driver: ProviderDriverKind;
      readonly nativeId: string;
      readonly strength: "strong";
    };
    readonly metadata?: OrchestrationV2ProviderThreadNativeMetadata;
  };
  /** Fork: custom group a newly created thread joins; ignored when reusing a thread. */
  readonly customGroupId?: string | null;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  /** The linked environment this launch is for, if one asked for it. */
  readonly linkOrigin?: OrchestrationV2LinkOrigin;
  /** The parent there, when that environment's agent delegated this as a task. */
  readonly delegatedFrom?: OrchestrationV2DelegatedFrom;
  /** The workflow run this thread is an agent step of. */
  readonly workflowRun?: OrchestrationV2WorkflowOrigin;
}

type PreparationInput = Pick<
  ThreadLaunchInput,
  "commandId" | "projectId" | "workspaceStrategy" | "initialMessage" | "linkOrigin"
> & {
  readonly reusedWorktree?: { readonly baseRef: string };
  /** Set when an agent asked for this run, with the thread it asked from if it has one. */
  readonly askedByAgent?: { readonly threadId: ThreadId | undefined };
};

export interface ThreadLaunchPreparationInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

export interface ThreadLaunchResult {
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection;
  /** The launch's last write (the initial message, else the thread claim) was accepted before this call. */
  readonly resumed: boolean;
  readonly sequence?: number;
}

export class ThreadLaunchError extends Schema.TaggedError<ThreadLaunchError>()(
  "ThreadLaunchError",
  {
    operation: Schema.Literals([
      "resolve-project",
      "read-receipt",
      "generate-metadata",
      "provision-worktree",
      "run-setup-script",
      "prepare-lab",
      "start-lab",
      "create-thread",
      "update-thread",
      "dispatch-message",
      "release-run",
      "fail-run",
    ]),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread launch ${this.commandId} failed during ${this.operation}.`;
  }
}

export class ThreadLaunchBaseRefError extends Schema.TaggedError<ThreadLaunchBaseRefError>()(
  "ThreadLaunchBaseRefError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    workspaceRoot: Schema.String,
    baseRef: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Base ref "${this.baseRef}" does not resolve to a commit in project "${this.projectTitle}" (${this.workspaceRoot}).`;
  }
}

export class ThreadLaunchBranchExistsError extends Schema.TaggedError<ThreadLaunchBranchExistsError>()(
  "ThreadLaunchBranchExistsError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    branch: Schema.String,
  },
) {
  override get message(): string {
    return `Branch "${this.branch}" already exists in project "${this.projectTitle}".`;
  }
}

export class ThreadLaunchBranchConflictError extends Schema.TaggedError<ThreadLaunchBranchConflictError>()(
  "ThreadLaunchBranchConflictError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    branch: Schema.String,
    conflictingBranch: Schema.String,
  },
) {
  override get message(): string {
    return `Branch "${this.branch}" cannot be created in project "${this.projectTitle}": branch "${this.conflictingBranch}" exists.`;
  }
}

export class ThreadLaunchNotRepositoryError extends Schema.TaggedError<ThreadLaunchNotRepositoryError>()(
  "ThreadLaunchNotRepositoryError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    workspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Project "${this.projectTitle}" (${this.workspaceRoot}) is not a Git repository.`;
  }
}

export class ThreadLaunchService extends Context.Service<
  ThreadLaunchService,
  {
    readonly launch: (
      input: ThreadLaunchInput,
    ) => Effect.Effect<
      ThreadLaunchResult,
      ThreadLaunchError | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
    /** Check a new worktree's base ref and branch name before creation for early errors; launch otherwise accepts and reports these failures inside the thread. */
    readonly checkWorktreeBase: (
      input: Pick<ThreadLaunchInput, "projectId" | "workspaceStrategy"> & {
        /** Skips the check when this launch was already accepted, so its retry replays. */
        readonly commandId?: CommandId;
      },
    ) => Effect.Effect<
      void,
      | ThreadLaunchBaseRefError
      | ThreadLaunchBranchExistsError
      | ThreadLaunchBranchConflictError
      | ThreadLaunchNotRepositoryError
      | TaskFolderError
    >;
    /** True only when the project's folder is known not to be a Git repository. */
    readonly isNonGitProject: (projectId: ProjectId) => Effect.Effect<boolean>;
    readonly retryPreparation: (
      input: ThreadLaunchPreparationInput,
    ) => Effect.Effect<
      Orchestrator.OrchestratorV2DispatchResult,
      | Orchestrator.OrchestratorV2Error
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
    readonly prepareRun: (input: ThreadLaunchPreparationInput) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadLaunchService") {}

const isThreadLaunchError = Schema.is(ThreadLaunchError);

function failureDetail(error: unknown): string {
  if (isThreadLaunchError(error)) {
    const cause = error.cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return `Workspace preparation failed during ${error.operation.replaceAll("-", " ")}: ${detail}`;
  }
  return `Workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`;
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const labs = yield* LabsService.LabsService;
  const setupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const cloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
  const terminals = yield* TerminalManager.TerminalManager;
  const git = yield* GitWorkflow.GitWorkflowService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const eventSink = yield* EventSink.EventSinkV2;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const taskFolders = yield* TaskFolders.TaskFolders;
  // A project-folder launch that names no branch records the folder's checkout, as the composer does.
  const launchBranch = (strategy: ThreadLaunchWorkspaceStrategy, workspaceRoot: string) =>
    strategy.type === "root" && strategy.branch === undefined
      ? git.currentBranch(workspaceRoot).pipe(Effect.orElseSucceed(() => null))
      : Effect.succeed(strategy.branch ?? null);
  const preparationScope = yield* Scope.make("sequential");
  const scheduledLaunches = yield* Ref.make<ReadonlySet<CommandId>>(new Set());
  yield* Effect.addFinalizer(() => Scope.close(preparationScope, Exit.void));

  const mapError =
    (input: PreparationInput, operation: ThreadLaunchError["operation"], threadId?: ThreadId) =>
    (cause: unknown) =>
      new ThreadLaunchError({
        operation,
        commandId: input.commandId,
        projectId: input.projectId,
        ...(threadId === undefined ? {} : { threadId }),
        cause,
      });

  // The administrator's limit, fixed for the server's life as it is where turns start.
  const maxRuntimeMode = serverSettings.managedPolicy?.limits?.maxRuntimeMode;
  /**
   * Whether the project's own code may run for this preparation. An agent has it run only from a
   * thread in Full access: the thread it asked from, or the one being prepared when it named
   * none, whose modes whoever asked could not set above their own. Asked again before each piece
   * of the project's code, since fetching and checking out in between can take minutes.
   */
  const projectCommandsFor = Effect.fn("ThreadLaunchService.projectCommandsFor")(function* (
    input: PreparationInput,
    threadId: ThreadId,
  ) {
    if (input.askedByAgent === undefined)
      return TaskFolders.projectCommandsForLink(input.linkOrigin);
    const live = (id: ThreadId) =>
      threads.getThreadShell(id).pipe(
        Effect.map((shell) => (shell === null || shell.deletedAt !== null ? null : shell)),
        Effect.orElseSucceed(() => null),
      );
    const asker = yield* live(input.askedByAgent.threadId ?? threadId);
    // A thread that cannot be read might be below Full access, the one that asked included.
    return TaskFolders.projectCommandsForAgent(
      input.linkOrigin,
      asker ?? { runtimeMode: "approval-required", interactionMode: "default" },
      maxRuntimeMode,
    );
  });

  // Who sent a run's message asked for the run; preparing it again asks for the same run.
  const askedByAgent = (
    thread: Pick<OrchestrationV2ThreadProjection["thread"], "createdBy">,
    message: OrchestrationV2ThreadProjection["messages"][number] | undefined,
  ): Pick<PreparationInput, "askedByAgent"> =>
    (message?.createdBy ?? thread.createdBy) === "agent"
      ? { askedByAgent: { threadId: message?.senderThreadId } }
      : {};

  const recordBranchRenameFailure = Effect.fn("ThreadLaunchService.recordBranchRenameFailure")(
    function* (threadId: ThreadId, runId: RunId, branch: string, cause: Cause.Cause<unknown>) {
      const error = Cause.squash(cause);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            type: "turn-item.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: ids.derive.runSignalTurnItem({ runId, signal: "branch-rename" }),
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              // EventSink allocates the real position, after the run's existing items.
              ordinal: 0,
              status: "completed",
              title: "Branch not renamed",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "system_notice",
              message: `Could not rename the worktree branch, so it stays ${branch}. ${error instanceof Error ? error.message : String(error)}`,
            },
          },
        ],
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record the branch rename failure", { cause }),
    ),
  );

  const readReceipt = (input: ThreadLaunchInput, commandId: CommandId) =>
    receipts
      .getByCommandId(commandId)
      .pipe(Effect.mapError(mapError(input, "read-receipt", input.threadId)));

  const validateReusableThread = Effect.fn("ThreadLaunchService.validateReusableThread")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
  ) {
    const projection = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
    if (
      projection.thread.projectId !== input.projectId ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      (yield* threads
        .getMessageCount(threadId)
        .pipe(Effect.mapError(mapError(input, "update-thread", threadId)))) > 0 ||
      projection.runs.length > 0
    ) {
      return yield* mapError(
        input,
        "update-thread",
        threadId,
      )("Only an empty active thread in the target project can change workspace during launch.");
    }
  });

  const hasLiveTerminalIn = Effect.fn("ThreadLaunchService.hasLiveTerminalIn")(function* (
    worktreePath: string,
    excludedTerminalId: string | null,
  ) {
    // subscribeMetadata delivers its full snapshot before returning.
    let live: ReadonlyArray<TerminalSummary> = [];
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") live = event.terminals;
      }),
    );
    unsubscribe();
    for (const terminal of live) {
      if (terminal.terminalId === excludedTerminalId) continue;
      if (terminal.status !== "starting" && terminal.status !== "running") continue;
      const cwd = yield* canonicalWorkspacePath(terminal.cwd);
      const relative = path.relative(worktreePath, cwd);
      if (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      )
        return true;
      if (
        terminal.worktreePath !== null &&
        (yield* canonicalWorkspacePath(terminal.worktreePath)) === worktreePath
      )
        return true;
    }
    return false;
  });

  /**
   * Fork: force-removes a checkout or task folder this launch created unless something else now
   * uses it, with every automatic removal's guard (other threads via alias or nested path, pending
   * archives and worktree moves, live provider sessions and terminals) under a removal reservation.
   * Returns whether removed.
   */
  const removeAbandonedWorktree = Effect.fn("ThreadLaunchService.removeAbandonedWorktree")(
    function* (
      threadId: ThreadId,
      projectRoot: string,
      worktreePath: string,
      setupTerminalId: string | null,
      createdTaskFolder: {
        readonly root: string;
        readonly deleteBranch: string | undefined;
        readonly projectCommands: TaskFolders.ProjectCommandsNow;
      } | null,
    ) {
      const taskFolder =
        createdTaskFolder === null ? null : yield* taskFolders.find(createdTaskFolder.root);
      // No record left: the task folder has nothing to remove.
      if (createdTaskFolder !== null && taskFolder?.root !== createdTaskFolder.root) return true;
      // A task folder is guarded whole: its root and each checkout recorded outside it.
      const footprint: string[] = [];
      for (const target of taskFolder === null
        ? [worktreePath]
        : [taskFolder.root, ...taskFolder.repositories.map((entry) => entry.worktreePath)]) {
        const canonical = yield* canonicalWorkspacePath(target);
        if (!footprint.some((held) => isWithinRoot(path, canonical, held)))
          footprint.push(canonical);
      }
      for (const target of footprint)
        if (!(yield* reserveWorkspace(target, "removal"))) return false;
      for (const target of footprint)
        if (yield* hasLiveTerminalIn(target, setupTerminalId)) return false;
      const active = yield* threads.getShellSnapshot({ location: "active" });
      const archived = yield* threads.getShellSnapshot({ location: "archive" });
      // An archive-location snapshot lists its rows under archivedThreads.
      const shells = [...active.threads, ...archived.archivedThreads];
      const sessionCwds = yield* readLiveProviderSessionCwds();
      for (const target of footprint)
        if (
          yield* storageCleanupWorktreeInUse({
            worktreePath: target,
            candidateId: threadId,
            threads: shells,
            sessionCwds,
          })
        )
          return false;
      // Terminal startup holds this lease: a terminal that opened before it was taken is seen here.
      const terminalOpened = Effect.gen(function* () {
        for (const target of footprint)
          if (yield* hasLiveTerminalIn(target, setupTerminalId)) return true;
        return false;
      });
      if (taskFolder === null || createdTaskFolder === null) {
        return yield* withWorkspaceLease(
          worktreePath,
          Effect.gen(function* () {
            if (yield* terminalOpened) return false;
            yield* git.removeWorktree({ cwd: projectRoot, path: worktreePath, force: true });
            return true;
          }),
        );
      }
      const removal = yield* withWorkspaceLease(
        worktreePath,
        Effect.gen(function* () {
          if (yield* terminalOpened) return null;
          return yield* taskFolders.remove({
            root: taskFolder.root,
            force: true,
            forget: true,
            projectCommands: createdTaskFolder.projectCommands,
            deleteBranch: createdTaskFolder.deleteBranch,
          });
        }),
      );
      if (removal === null) return false;
      const { kept } = removal;
      if (kept.length > 0) {
        return yield* new TaskFolderError({
          operation: "remove",
          detail: `Kept ${kept.map((entry) => entry.path).join(", ")}.`,
        });
      }
      return true;
    },
    Effect.scoped,
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  const checkWorktreeBase: ThreadLaunchService["Service"]["checkWorktreeBase"] = Effect.fn(
    "ThreadLaunchService.checkWorktreeBase",
  )(function* (input) {
    const strategy = input.workspaceStrategy;
    if (strategy.type !== "worktree") return;
    const commandId = input.commandId;
    const [isScratch, receipt, projectOption] = yield* Effect.all(
      [
        managedFolders.isScratchProject(input.projectId),
        commandId === undefined
          ? Effect.succeedNone
          : receipts.getByCommandId(commandId).pipe(Effect.orElseSucceed(() => Option.none())),
        projects.getById(input.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
      ],
      { concurrency: "unbounded" },
    );
    // launch() turns a Scratch worktree request into a root launch.
    if (isScratch) return;
    if (Option.isSome(receipt) && receipt.value.status === "accepted") return;
    const project = Option.getOrUndefined(projectOption);
    if (project === undefined) return;
    const cwd = project.workspaceRoot;
    const taskPlan = yield* taskFolders.plan({
      projectId: project.id,
      repositories: strategy.repositories,
    });
    // Each repository of a plain project folder starts from its own default branch.
    if (taskPlan !== null && !taskPlan.projectIsRepository) return;
    const { baseRef, branch } = strategy;
    // Errors keep their order below: missing repository, then base ref, then branch exists or conflicts.
    const [repositoryRoot, hasBaseCommit, localBranches] = yield* Effect.all(
      [
        git.repositoryRoot(cwd).pipe(Effect.orElseSucceed(() => undefined)),
        // `:/text` is a commit search, which cannot be asked for a commit type.
        baseRef.startsWith(":")
          ? Effect.succeed(true)
          : // `git worktree add` reads `-` as the previous checkout.
            git
              .hasCommit({ cwd, refName: baseRef === "-" ? "@{-1}" : baseRef })
              .pipe(Effect.orElseSucceed(() => true)),
        branch !== undefined
          ? git
              .listLocalBranchNames(cwd)
              .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
          : Effect.succeed<ReadonlyArray<string>>([]),
      ],
      { concurrency: "unbounded" },
    );
    if (repositoryRoot === null)
      return yield* new ThreadLaunchNotRepositoryError({
        projectId: project.id,
        projectTitle: project.title,
        workspaceRoot: cwd,
      });
    const baseResolves =
      hasBaseCommit ||
      (yield* Effect.gen(function* () {
        if (strategy.startFromOrigin === true) {
          const remote = yield* git.resolveWorktreeBaseRemote({ cwd, refName: baseRef });
          // The remote may have deleted the branch; ask it rather than trusting the name.
          if (
            remote !== null &&
            (yield* git.fetchWorktreeBaseCommit({ cwd, refName: baseRef, remote })) !== null
          )
            return true;
        }
        // createWorktree starts a new branch from the primary remote's branch of that name.
        if ((yield* git.resolvePrimaryRemoteTrackingRef({ cwd, refName: baseRef })) !== null)
          return true;
        return !(yield* git.hasCommit({ cwd, refName: "HEAD" }));
      }).pipe(Effect.orElseSucceed(() => true)));
    if (!baseResolves)
      return yield* new ThreadLaunchBaseRefError({
        projectId: project.id,
        projectTitle: project.title,
        workspaceRoot: project.workspaceRoot,
        baseRef,
      });
    if (branch === undefined) return;
    if (localBranches.includes(branch))
      return yield* new ThreadLaunchBranchExistsError({
        projectId: project.id,
        projectTitle: project.title,
        branch,
      });
    // Provisioning flattens temporary names that collide, so only explicit names are refused.
    if (isTemporaryWorktreeBranch(branch)) return;
    const conflictingBranch = localBranches.find(
      (existing) => existing.startsWith(`${branch}/`) || branch.startsWith(`${existing}/`),
    );
    if (conflictingBranch !== undefined)
      return yield* new ThreadLaunchBranchConflictError({
        projectId: project.id,
        projectTitle: project.title,
        branch,
        conflictingBranch,
      });
  });

  const isNonGitProject: ThreadLaunchService["Service"]["isNonGitProject"] = Effect.fn(
    "ThreadLaunchService.isNonGitProject",
  )(function* (projectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project)) return false;
    // Unlike `git.repositoryRoot`, this fails on a repository Git cannot read, which is not "no repository".
    return yield* checkpointStore.isGitRepository(project.value.workspaceRoot).pipe(
      Effect.map((isRepository) => !isRepository),
      Effect.orElseSucceed(() => false),
    );
  });

  /**
   * A recorded worktree strategy can outlive the ref it names: tasks saved before
   * the base followed the repo's default branch kept `"main"`, and a base branch
   * can be deleted after it was recorded. Re-base on the remote's default branch,
   * then on the checked-out commit, instead of failing every launch.
   */
  const worktreeFallbackBase = Effect.fn("ThreadLaunchService.worktreeFallbackBase")(function* (
    cwd: string,
    remoteName: string | null,
  ) {
    if (remoteName !== null) {
      const defaultBranch = yield* git.resolveDefaultBranchName(cwd, remoteName);
      if (defaultBranch !== null) {
        // Fetch freshens the default branch the way the recorded base would have been.
        const remoteBase = yield* git
          .fetchWorktreeBaseCommit({
            cwd,
            refName: defaultBranch,
            remote: { remoteName, branchName: defaultBranch },
          })
          .pipe(
            Effect.map((base) => ({ fetchFailed: false as const, base })),
            Effect.orElseSucceed(() => ({ fetchFailed: true as const, base: null })),
          );
        if (remoteBase.base !== null) {
          return {
            startRef: remoteBase.base.commitSha,
            baseRefName: `refs/remotes/${remoteBase.base.remoteRefName}`,
          };
        }
        // A completed fetch that found no branch means the branch is gone and its
        // tracking ref is stale; only a failed fetch can fall back to it.
        if (remoteBase.fetchFailed) {
          const trackingRef = `refs/remotes/${remoteName}/${defaultBranch}`;
          if (yield* git.hasCommit({ cwd, refName: trackingRef })) {
            return { startRef: trackingRef, baseRefName: trackingRef };
          }
        }
      }
    }
    const currentBranch = yield* git.currentBranch(cwd);
    if (currentBranch !== null) {
      return { startRef: currentBranch, baseRefName: currentBranch };
    }
    return (yield* git.hasCommit({ cwd, refName: "HEAD" }))
      ? { startRef: "HEAD", baseRefName: "HEAD" }
      : null;
  });

  const prepareInBackground = Effect.fn("ThreadLaunchService.prepareInBackground")(function* (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project", threadId)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(mapError(input, "resolve-project", threadId)("Project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

    const reused = input.reusedWorktree;
    const tracked =
      input.workspaceStrategy.type === "worktree" ||
      input.workspaceStrategy.type === "lab" ||
      reused !== undefined;
    let createdWorktreePath: string | null = null;
    let createdBranch: string | null = null;
    let createdTaskFolder: string | null = null;
    let setupTerminalId: string | null = null;
    let workspaceRecorded = false;
    let runReleased = false;
    // Stop background renames before forgetting worktrees; completed renames record them again.
    let branchRename: Fiber.Fiber<unknown> | null = null;
    let stopBranchName: Effect.Effect<void> = Effect.void;
    if (input.workspaceStrategy.type === "lab") {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: input.workspaceStrategy.baseRef ?? null,
        stages: ["lab-reservation", "lab-startup", "agent"],
        fiber: yield* Effect.fiber,
      });
    } else if (input.workspaceStrategy.type === "worktree") {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: input.workspaceStrategy.baseRef,
        stages: ["fetch", "checkout", "submodules", "setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
    } else if (reused !== undefined) {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: reused.baseRef,
        stages: ["setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
    }
    const projectCommandsNow = projectCommandsFor(input, threadId);
    yield* Effect.gen(function* () {
      const initialMessage = input.initialMessage;
      const generateBranchNameFor = Effect.fn("ThreadLaunchService.generateBranchNameFor")(
        function* (cwd: string, message: ThreadLaunchInitialMessage) {
          const settings = resolveProjectSettings(
            yield* serverSettings.getSettings,
            input.projectId,
          ).settings;
          const modelSelection =
            settings.sourceControlWriterModelSelection === null
              ? settings.textGenerationModelSelection
              : ServerSettings.resolveSourceControlWriterModelSelection(
                  settings,
                  yield* providerRegistry.getProviders,
                  input.projectId,
                );
          return yield* textGeneration
            .generateBranchName({
              naming: {
                mode: settings.branchNamingMode,
                prefix: settings.branchNamePrefix,
                instructions: settings.branchNameInstructions,
              },
              cwd,
              message: message.text,
              attachments: message.attachments,
              ...(message.context ? { context: message.context } : {}),
              modelSelection,
              projectId: input.projectId,
            })
            .pipe(
              Effect.timeoutOrElse({
                duration: BRANCH_NAME_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new TextGenerationError({
                      operation: "generateBranchName",
                      detail: `Timed out after ${BRANCH_NAME_TIMEOUT}.`,
                    }),
                  ),
              }),
              Effect.map((result) => ({
                branch: result.branch,
                exactName: settings.branchNamingMode === "custom",
              })),
            );
        },
      );

      const requestedBranch = input.workspaceStrategy.branch;
      const generatedTemporaryBranch =
        input.workspaceStrategy.type === "worktree" && requestedBranch === undefined;
      let branch: string | null;
      if (generatedTemporaryBranch) {
        const uuid = yield* randomUuidV4;
        branch = buildTemporaryWorktreeBranchName(() => uuid.replaceAll("-", ""));
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.map((settings) => resolveProjectSettings(settings, input.projectId).settings),
          Effect.orElseSucceed(() => null),
        );
        if (settings?.branchNamingMode === "static") {
          branch = formatGeneratedBranchName(branch.slice(-8), {
            mode: "static",
            prefix: settings.branchNamePrefix,
            instructions: "",
          });
        }
      } else {
        branch = yield* launchBranch(input.workspaceStrategy, project.workspaceRoot);
      }
      let worktreePath =
        input.workspaceStrategy.type === "existing_worktree"
          ? input.workspaceStrategy.worktreePath
          : null;
      let preparedLab: import("@t3tools/contracts").LabsPrepareThreadResult | null = null;
      if (input.workspaceStrategy.type === "lab") {
        yield* setupTracker.stageStatus(threadId, "lab-reservation", "running");
        preparedLab = yield* labs
          .prepareAgentThread({
            ...input.workspaceStrategy,
            threadId,
            projectId: input.projectId,
          })
          .pipe(Effect.mapError(mapError(input, "prepare-lab", threadId)));
        worktreePath = preparedLab.worktreePath;
        branch = preparedLab.branch;
        yield* setupTracker.update(threadId, (snapshot) => ({ ...snapshot, worktreePath, branch }));
        yield* setupTracker.stageStatus(threadId, "lab-reservation", "done", preparedLab.labId);
      }
      // The agent waits for this LLM call; start it now so it overlaps fetch, checkout and setup.
      const branchName =
        reused === undefined &&
        initialMessage !== undefined &&
        (input.workspaceStrategy.type === "worktree" || worktreePath !== null) &&
        branch !== null &&
        (generatedTemporaryBranch || isTemporaryWorktreeBranch(branch))
          ? yield* generateBranchNameFor(
              worktreePath ?? project.workspaceRoot,
              initialMessage,
            ).pipe(Effect.forkIn(preparationScope))
          : null;
      if (branchName !== null) stopBranchName = Fiber.interrupt(branchName);
      if (input.workspaceStrategy.type === "worktree") {
        const taskPlan = yield* taskFolders
          .plan({ projectId: project.id, repositories: input.workspaceStrategy.repositories })
          .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
        // A plain project folder has no branch of its own to fetch or start from.
        const projectIsRepository = taskPlan === null || taskPlan.projectIsRepository;
        if (runId !== null) {
          yield* threads
            .dispatch({
              type: "prepared-run.progress",
              commandId: CommandId.make(`${input.commandId}:progress:worktree`),
              threadId,
              runId,
              phase: "worktree",
            })
            .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
        }
        const requestedBaseRef = input.workspaceStrategy.baseRef;
        let startRef = requestedBaseRef;
        let baseRefName = requestedBaseRef;
        const remote =
          input.workspaceStrategy.startFromOrigin === true && projectIsRepository
            ? yield* git
                .resolveWorktreeBaseRemote({
                  cwd: project.workspaceRoot,
                  refName: input.workspaceStrategy.baseRef,
                })
                .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)))
            : null;
        const shouldFetch = remote !== null;
        yield* setupTracker.stageStatus(threadId, "fetch", shouldFetch ? "running" : "skipped");
        let fetchedBase = false;
        if (remote !== null) {
          const remoteBase = yield* git
            .fetchWorktreeBaseCommit({
              cwd: project.workspaceRoot,
              refName: input.workspaceStrategy.baseRef,
              remote,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
          if (remoteBase !== null) {
            startRef = remoteBase.commitSha;
            baseRefName = `refs/remotes/${remoteBase.remoteRefName}`;
            fetchedBase = true;
          }
        }
        if (shouldFetch) yield* setupTracker.stageStatus(threadId, "fetch", "done");
        // `:/text` bases are commit searches, not refs; `hasCommit` treats the appended
        // `^{commit}` as part of the pattern (same guard as checkWorktreeBase).
        const recordedBaseResolves =
          !projectIsRepository ||
          fetchedBase ||
          startRef.startsWith(":") ||
          (yield* git
            .hasCommit({
              cwd: project.workspaceRoot,
              // `git worktree add` reads `-` as the previous checkout.
              refName: startRef === "-" ? "@{-1}" : startRef,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId))));
        if (!recordedBaseResolves) {
          const remoteName =
            remote?.remoteName ??
            (yield* git
              .resolvePrimaryRemoteName(project.workspaceRoot)
              .pipe(Effect.orElseSucceed(() => null)));
          const fallback = yield* worktreeFallbackBase(project.workspaceRoot, remoteName).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (fallback !== null) {
            startRef = fallback.startRef;
            baseRefName = fallback.baseRefName;
            yield* setupTracker.update(threadId, (snapshot) => ({
              ...snapshot,
              baseRef: fallback.baseRefName,
            }));
          }
        }
        if (
          branch !== null &&
          projectIsRepository &&
          (generatedTemporaryBranch || isTemporaryWorktreeBranch(branch))
        ) {
          const parts = branch.split("/");
          for (let depth = 1; depth < parts.length; depth++) {
            if (
              yield* git
                .hasCommit({
                  cwd: project.workspaceRoot,
                  refName: `refs/heads/${parts.slice(0, depth).join("/")}`,
                })
                .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)))
            ) {
              branch = generatedTemporaryBranch
                ? branch.replaceAll("/", "-")
                : flattenTemporaryWorktreeBranchName(branch);
              break;
            }
          }
        }
        yield* setupTracker.stageStatus(threadId, "checkout", "running");
        let submoduleProgressReportedAt = Number.NEGATIVE_INFINITY;
        const progress: GitVcsDriver.CreateWorktreeProgress = {
          onWorktreeClaimed: (path) =>
            Effect.sync(() => {
              createdWorktreePath = path;
              // A task folder has already claimed the name its repositories share.
              createdBranch ??= branch;
            }),
          onCheckoutProgress: (progress) =>
            setupTracker.stage(threadId, "checkout", { percent: progress.percent }),
          onSubmodulesStarted: () =>
            setupTracker
              .stageStatus(threadId, "checkout", "done")
              .pipe(Effect.andThen(setupTracker.stageStatus(threadId, "submodules", "running"))),
          onSubmodulesDisabled: ({ source }) =>
            setupTracker.stageStatus(threadId, "submodules", "skipped", `disabled in ${source}`),
          onSubmoduleLine: (line) => {
            // Paths may contain quotes; git closes the path with "': ".
            const submodulePath = /^\s*Submodule path '(.+)': /.exec(line)?.[1];
            if (submodulePath !== undefined) {
              return setupTracker.stage(threadId, "submodules", { detail: submodulePath });
            }
            if (parseGitCloneProgressLine(line) === null) return Effect.void;
            // Git redraws on every percent; hold the websocket to one update a second.
            return Effect.flatMap(Clock.currentTimeMillis, (now) => {
              if (now - submoduleProgressReportedAt < 1000) return Effect.void;
              submoduleProgressReportedAt = now;
              return setupTracker.stage(threadId, "submodules", {
                detail: line.trim().replace(/\s+/g, " "),
              });
            });
          },
          onSubmodulesFinished: ({ ok, detail }) =>
            setupTracker.stageStatus(
              threadId,
              "submodules",
              ok ? "done" : "warning",
              ok ? undefined : (detail ?? "submodule checkout failed"),
            ),
        };
        const worktree =
          taskPlan === null
            ? (yield* git
                .createWorktree(
                  {
                    cwd: project.workspaceRoot,
                    refName: startRef,
                    newRefName: branch!,
                    baseRefName,
                    path: null,
                  },
                  { progress },
                )
                .pipe(
                  Effect.catchIf(
                    (error) => error.reason === "ref_not_found",
                    (cause) =>
                      Effect.fail(
                        new ThreadLaunchBaseRefError({
                          projectId: project.id,
                          projectTitle: project.title,
                          workspaceRoot: project.workspaceRoot,
                          baseRef: requestedBaseRef,
                          cause,
                        }),
                      ),
                  ),
                  Effect.mapError(mapError(input, "provision-worktree", threadId)),
                )).worktree
            : yield* taskFolders
                .create({
                  plan: taskPlan,
                  branch: branch!,
                  projectStart: { refName: startRef, baseRefName },
                  baseBranch: input.workspaceStrategy.baseRef,
                  startFromOrigin: input.workspaceStrategy.startFromOrigin === true,
                  projectCommands: projectCommandsNow,
                  projectProgress: progress,
                  onClaimed: (taskFolder, claimedBranch) =>
                    Effect.sync(() => {
                      createdTaskFolder = taskFolder.root;
                      createdWorktreePath = taskFolder.projectPath;
                      createdBranch = claimedBranch;
                    }),
                  onRepository: ({ name, done, total }) =>
                    setupTracker.stage(threadId, "checkout", {
                      detail: `${name} (${done} of ${total})`,
                    }),
                })
                .pipe(
                  Effect.map((created) => ({
                    path: created.taskFolder.projectPath,
                    refName: created.branch,
                  })),
                  Effect.mapError(mapError(input, "provision-worktree", threadId)),
                );
        worktreePath = worktree.path;
        branch = worktree.refName;
        createdWorktreePath = worktreePath;
        createdBranch = branch;
        yield* setupTracker.update(threadId, (snapshot) => ({
          ...snapshot,
          worktreePath,
          branch,
          stages: snapshot.stages.map((stage) =>
            stage.id === "submodules" && stage.status === "pending"
              ? { ...stage, status: "skipped", detail: "none" }
              : stage,
          ),
        }));
        yield* setupTracker.stageStatus(threadId, "checkout", "done");
      }

      // Do not rewrite reused worktrees; that could undo the original branch rename.
      if (reused === undefined) {
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${input.commandId}:workspace`),
            threadId,
            branch,
            worktreePath,
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      workspaceRecorded = true;

      if (
        reused === undefined &&
        worktreePath !== null &&
        branch !== null &&
        initialMessage !== undefined &&
        (generatedTemporaryBranch || isTemporaryWorktreeBranch(branch))
      ) {
        const oldBranch = branch;
        const worktreeCwd = worktreePath;
        const generatedName =
          branchName === null
            ? generateBranchNameFor(worktreeCwd, initialMessage)
            : Fiber.join(branchName);
        branchRename = yield* generatedName.pipe(
          Effect.flatMap(({ branch: newBranch, exactName }) =>
            Effect.suspend(
              (): Effect.Effect<
                { readonly branch: string },
                GitManagerServiceError | TaskFolderError
              > =>
                createdTaskFolder === null
                  ? git.renameBranch({
                      cwd: worktreeCwd,
                      oldBranch,
                      newBranch,
                      ...(exactName ? { exactName: true } : {}),
                    })
                  : taskFolders.renameBranch({
                      root: createdTaskFolder,
                      oldBranch,
                      newBranch,
                      ...(exactName ? { exactName: true } : {}),
                    }),
            ).pipe(
              // A cancel must see the renamed branch, or its cleanup deletes the old name.
              Effect.tap((renamed) =>
                Effect.sync(() => {
                  createdBranch = renamed.branch;
                }),
              ),
              Effect.uninterruptible,
            ),
          ),
          Effect.flatMap((renamed) =>
            Effect.gen(function* () {
              yield* threads
                .dispatch({
                  type: "thread.metadata.update",
                  commandId: CommandId.make(`${input.commandId}:branch-rename`),
                  threadId,
                  branch: renamed.branch,
                  worktreePath: worktreeCwd,
                  expectedBranch: oldBranch,
                  expectedWorktreePath: worktreeCwd,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Parent thread worktree branch update failed", {
                      threadId,
                      cause,
                    }),
                  ),
                );
              // Update parents first so children inherit names; reread each pass for newly updated descendants.
              const visited = new Set([threadId]);
              while (true) {
                const snapshot = yield* threads.getShellSnapshot({ worktreePath: worktreeCwd });
                const sharing = [...snapshot.threads, ...snapshot.archivedThreads].filter(
                  (thread) => !visited.has(thread.id) && thread.branch === oldBranch,
                );
                if (sharing.length === 0) break;
                for (const thread of sharing) {
                  visited.add(thread.id);
                  yield* threads
                    .dispatch({
                      type: "thread.metadata.update",
                      commandId: CommandId.make(`${input.commandId}:branch-rename:${thread.id}`),
                      threadId: thread.id,
                      branch: renamed.branch,
                      expectedBranch: oldBranch,
                      expectedWorktreePath: worktreeCwd,
                    })
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning("Shared thread worktree branch update failed", {
                          threadId: thread.id,
                          cause,
                        }),
                      ),
                    );
                }
              }
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Thread worktree branch rename failed", {
              commandId: input.commandId,
              threadId,
              oldBranch,
              cause,
            }).pipe(
              Effect.andThen(
                runId === null || Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : recordBranchRenameFailure(threadId, runId, oldBranch, cause),
              ),
            ),
          ),
          Effect.forkIn(preparationScope),
        );
      } else {
        yield* stopBranchName;
      }

      if (runId !== null && worktreePath !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.progress",
            commandId: CommandId.make(`${input.commandId}:progress:setup`),
            threadId,
            runId,
            phase: "setup",
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      if (preparedLab !== null) {
        yield* setupTracker.stageStatus(threadId, "lab-startup", "running");
        yield* labs
          .startThread({
            threadId,
            labId: preparedLab.labId,
            leaseId: preparedLab.leaseId,
          })
          .pipe(Effect.mapError(mapError(input, "start-lab", threadId)));
        yield* setupTracker.stageStatus(threadId, "lab-startup", "done");
      }
      yield* setupTracker.stageStatus(threadId, "setup-script", "running");
      // The saved setup script is the project's code too. Fork (SP Labs): sp-labs provisions
      // lab worktrees; see isSpLabWorktree. A reused worktree is one this service created.
      const setup =
        worktreePath === null ||
        preparedLab !== null ||
        (yield* projectCommandsNow) === "agent-below-full-access" ||
        (input.workspaceStrategy.type === "existing_worktree" &&
          reused === undefined &&
          (yield* isSpLabWorktree(fs, path, worktreePath)))
          ? ({ status: "no-script" } as const)
          : yield* setupScripts
              .runForThread({
                threadId,
                projectId: input.projectId,
                projectCwd: project.workspaceRoot,
                worktreePath,
                ...(tracked
                  ? {
                      observeCompletion: {
                        onOutputLine: (line: string) =>
                          setupTracker.appendTail(threadId, "setup-script", line),
                      },
                    }
                  : {}),
                project: {
                  id: project.id,
                  workspaceRoot: project.workspaceRoot,
                  scripts: project.scripts,
                },
              })
              .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)));

      let awaitAsyncSetup = Effect.void;
      if (setup.status === "started") {
        setupTerminalId = setup.terminalId;
        yield* setupTracker.update(threadId, (snapshot) => ({
          ...snapshot,
          setupScript: {
            name: setup.scriptName,
            command: setup.scriptCommand,
            terminalId: setup.terminalId,
          },
        }));
        if (setup.completion) {
          const awaitCompletion = Effect.gen(function* () {
            const completion = yield* setup.completion!;
            yield* setupTracker.stageStatus(
              threadId,
              "setup-script",
              completion.exitCode === 0 ? "done" : "failed",
              `exited with ${completion.exitCode ?? "no exit code"}`,
            );
            if (completion.exitCode !== 0 && !setup.async)
              return yield* mapError(
                input,
                "run-setup-script",
                threadId,
              )(`Setup script exited with ${completion.exitCode ?? "no exit code"}.`);
          });
          if (setup.async) {
            // Record the result when the script ends, not after the agent starts.
            const asyncSetup = yield* awaitCompletion.pipe(
              Effect.catchCause((cause) =>
                setupTracker.stageStatus(
                  threadId,
                  "setup-script",
                  "failed",
                  failureDetail(Cause.squash(cause)),
                ),
              ),
              Effect.forkChild,
            );
            awaitAsyncSetup = Fiber.join(asyncSetup);
          } else {
            yield* awaitCompletion;
          }
        } else {
          yield* setupTracker.stageStatus(threadId, "setup-script", "done");
        }
      } else {
        yield* setupTracker.stageStatus(threadId, "setup-script", "skipped");
      }
      // The agent must start on the branch name the thread will show.
      if (branchRename !== null) yield* Fiber.join(branchRename);
      yield* setupTracker.markUncancellable(threadId);
      yield* setupTracker.stageStatus(threadId, "agent", "running");
      if (runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make(`${input.commandId}:release`),
            threadId,
            runId,
          })
          .pipe(
            Effect.mapError(mapError(input, "release-run", threadId)),
            Effect.tap(() =>
              Effect.sync(() => {
                runReleased = true;
              }),
            ),
            Effect.uninterruptible,
          );
      }
      yield* setupTracker.stageStatus(threadId, "agent", "done");
      yield* awaitAsyncSetup;
      yield* setupTracker.finish(threadId, "done");
    }).pipe(
      Effect.onError((cause) =>
        Effect.gen(function* () {
          const cancelled = Cause.hasInterruptsOnly(cause);
          // Not yet handed to a rename, so nothing will use the name.
          if (branchRename === null) yield* stopBranchName;
          const snapshot = yield* setupTracker.get(threadId);
          for (const stage of snapshot?.stages ?? []) {
            if (stage.status === "running") {
              yield* setupTracker.stageStatus(threadId, stage.id, cancelled ? "skipped" : "failed");
            }
          }
          yield* setupTracker.finish(
            threadId,
            cancelled ? "cancelled" : "failed",
            cancelled ? null : failureDetail(Cause.squash(cause)),
          );
          if (cancelled && setupTerminalId)
            yield* terminals
              .close({ threadId, terminalId: setupTerminalId, deleteHistory: true })
              .pipe(Effect.ignore);
          if (
            tracked &&
            createdWorktreePath &&
            ((cancelled && !runReleased) || !workspaceRecorded)
          ) {
            if (branchRename !== null) yield* Fiber.interrupt(branchRename);
            yield* stopBranchName;
            const removedPath = createdWorktreePath;
            const removedBranch = createdBranch;
            const removedTaskFolder = createdTaskFolder;
            // Forget worktrees only after removal succeeds; failed removals must not reuse partially written checkouts.
            yield* Effect.gen(function* () {
              const removed = yield* removeAbandonedWorktree(
                threadId,
                project.workspaceRoot,
                removedPath,
                setupTerminalId,
                removedTaskFolder === null
                  ? null
                  : {
                      root: removedTaskFolder,
                      deleteBranch: removedBranch ?? undefined,
                      projectCommands: projectCommandsNow,
                    },
              );
              if (!removed) {
                return yield* Effect.logInfo(
                  "Kept an abandoned thread worktree that is still in use",
                  { commandId: input.commandId, threadId, path: removedPath },
                );
              }
              if (removedTaskFolder === null && removedBranch !== null) {
                yield* git
                  .deleteLocalBranch({
                    cwd: project.workspaceRoot,
                    refName: removedBranch,
                    force: true,
                  })
                  .pipe(Effect.ignoreCause({ log: true }));
              }
              yield* threads
                .dispatch({
                  type: "thread.metadata.update",
                  commandId: CommandId.make(`${input.commandId}:cancel-workspace`),
                  threadId,
                  worktreePath: null,
                  branch: null,
                })
                .pipe(Effect.ignore);
            }).pipe(
              Effect.catchCause((removeCause) =>
                Effect.logWarning("Failed to remove an abandoned thread worktree", {
                  commandId: input.commandId,
                  threadId,
                  path: removedPath,
                  cause: removeCause,
                }),
              ),
            );
          }
        }),
      ),
    );
  });

  // Fork: launch returns before preparation runs, so wake the thread that sent the first message.
  // Delegated children are skipped; their parent hears through the task's completion.
  const notifyLauncher = Effect.fn("ThreadLaunchService.notifyLauncher")(function* (
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
    detail: string,
  ) {
    const { thread, runs } = yield* threads.getThreadRecords(threadId, ["runs"], {
      runIds: [runId],
    });
    const run = runs.find((candidate) => candidate.id === runId);
    if (run === undefined || thread.lineage.parentThreadId !== null) return;
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageIds: [run.userMessageId],
    });
    const senderThreadId = messages.find(
      (message) => message.id === run.userMessageId,
    )?.senderThreadId;
    if (senderThreadId === undefined || senderThreadId === threadId) return;
    const sender = yield* threads.getThreadShell(senderThreadId);
    if (sender === null || sender.archivedAt !== null || sender.deletedAt !== null) return;
    const label = reportLabel(thread.title);
    const text = `Thread${label === undefined ? "" : ` "${label}"`} (threadId ${threadId}), which you launched, failed before its agent started. ${detail} Fix the cause, then call t3_thread_launch again with a new clientRequestId; the old one returns this failed thread.`;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${commandId}:notify-launcher`),
      threadId: senderThreadId,
      messageId: MessageId.make(`message:launch-preparation-failed:${commandId}`),
      text,
      notification: {
        source: { kind: "system" },
        outcome: "failed",
        summary: `Thread${label === undefined ? "" : ` "${label}"`} failed to start`,
        detail: text,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const failPreparedRun = (
    input: Pick<PreparationInput, "commandId">,
    threadId: ThreadId,
    runId: RunId | null,
    cause: unknown,
    retryPersistence = true,
    notify = true,
  ) => {
    if (runId === null) {
      return Effect.logWarning("Thread workspace preparation failed", {
        commandId: input.commandId,
        threadId,
        cause,
      });
    }
    const persistFailure = threads.dispatch({
      type: "prepared-run.fail",
      commandId: CommandId.make(`${input.commandId}:fail`),
      threadId,
      runId,
      failure: makeProviderFailure({
        cause,
        message: failureDetail(cause),
        class: "validation_error",
        retryable: false,
      }),
    });
    const notifyFailure = (
      notify ? notifyLauncher(input.commandId, threadId, runId, failureDetail(cause)) : Effect.void
    ).pipe(
      Effect.catchCause((notifyCause) =>
        Effect.logWarning("Failed to notify the launcher of a preparation failure", {
          commandId: input.commandId,
          threadId,
          cause: notifyCause,
        }),
      ),
    );
    const runIsPreparing = threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
      Effect.map((current) =>
        current.runs.some((run) => run.id === runId && run.status === "preparing"),
      ),
      // The read can fail in the same outage, which says nothing about the run.
      Effect.catchCause(() => Effect.succeed(true)),
    );
    return persistFailure.pipe(
      Effect.andThen(notifyFailure),
      Effect.catchCause((persistCause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Failed to persist thread workspace preparation failure", {
            commandId: input.commandId,
            threadId,
            cause,
            persistCause,
          });
          if (
            !retryPersistence ||
            Cause.hasInterruptsOnly(persistCause) ||
            !(yield* runIsPreparing)
          )
            return;
          // A full disk rejects this write as well, and nothing else moves the run out of
          // "preparing", so it would hold the thread's queue until a restart. Retry until
          // storage recovers or the run settles another way.
          yield* persistFailure.pipe(
            Effect.as(true),
            // Storage failures can be defects; retry both failure channels.
            Effect.catchCauseIf(
              (retryCause) => !Cause.hasInterruptsOnly(retryCause),
              (retryCause) =>
                runIsPreparing.pipe(
                  Effect.flatMap((preparing) =>
                    preparing ? Effect.fail(retryCause) : Effect.succeed(false),
                  ),
                ),
            ),
            Effect.retry(
              Schedule.exponential("1 second").pipe(
                Schedule.modifyDelay(({ duration }) =>
                  Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                ),
              ),
            ),
            Effect.flatMap((persisted) => (persisted ? notifyFailure : Effect.void)),
            Effect.ignoreCause,
            // Callers reach this from finalizers; shutdown must still be able to stop it.
            Effect.interruptible,
          );
        }),
      ),
    );
  };

  const reservePreparation = (commandId: CommandId) =>
    Ref.modify(scheduledLaunches, (scheduled) => {
      if (scheduled.has(commandId)) return [false, scheduled] as const;
      const next = new Set(scheduled);
      next.add(commandId);
      return [true, next] as const;
    });

  const releasePreparation = (commandId: CommandId) =>
    Ref.update(scheduledLaunches, (scheduled) => {
      const next = new Set(scheduled);
      next.delete(commandId);
      return next;
    });

  const schedulePreparation = Effect.fn("ThreadLaunchService.schedulePreparation")(function* (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const preparation = Effect.gen(function* () {
      const prepare = prepareInBackground(input, threadId, runId);
      if (
        runId === null ||
        (input.workspaceStrategy.type !== "worktree" &&
          input.workspaceStrategy.type !== "lab" &&
          input.reusedWorktree === undefined)
      ) {
        return yield* prepare;
      }
      const afterSequence = yield* threads.getThreadEventSequence(threadId);
      const projection = yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] });
      if (projection.runs.find((run) => run.id === runId)?.status !== "preparing") return;
      const interruption = threads
        .streamStoredEventsFrom({ threadId, afterSequence, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === runId &&
              (stored.event.payload.status === "interrupted" ||
                stored.event.payload.status === "cancelled"),
          ),
          Stream.runHead,
          Effect.flatMap((event) => (Option.isSome(event) ? Effect.interrupt : Effect.never)),
        );
      yield* Effect.raceFirst(prepare, interruption);
    });
    yield* preparation.pipe(
      Effect.onError((cause) => {
        const cancelled = Cause.hasInterruptsOnly(cause);
        return failPreparedRun(
          input,
          threadId,
          runId,
          cancelled ? "Worktree setup cancelled." : Cause.squash(cause),
          true,
          !cancelled,
        );
      }),
      Effect.ignoreCause,
      Effect.ensuring(releasePreparation(input.commandId)),
      Effect.forkIn(preparationScope),
    );
  });

  const launch: ThreadLaunchService["Service"]["launch"] = Effect.fn("ThreadLaunchService.launch")(
    function* (request) {
      // Scratch has no Git repository. Normalize before folder allocation so
      // durable preparation and retries use the thread's own Scratch folder.
      const input: ThreadLaunchInput =
        request.workspaceStrategy.type === "worktree" &&
        (yield* managedFolders.isScratchProject(request.projectId))
          ? { ...request, workspaceStrategy: { type: "root" } }
          : request;
      yield* ProjectCloneTracker.rejectCommandsDuringClone(cloneTracker, {
        type: "thread.create",
        projectId: input.projectId,
      }).pipe(Effect.mapError(mapError(input, "resolve-project")));
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.mapError(mapError(input, "resolve-project")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(mapError(input, "resolve-project")("Project not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (input.reuseExistingThread === true && input.threadId === undefined) {
        return yield* mapError(
          input,
          "update-thread",
        )("Reusing an existing thread requires a thread id.");
      }

      const launchReceipt = yield* readReceipt(input, input.commandId);
      yield* threads.assertProviderInstanceEnabled({
        projectId: input.projectId,
        commandId: input.commandId,
        instanceId: input.modelSelection.instanceId,
      });
      return yield* Effect.gen(function* () {
        // Recover ids from accepted launch receipts before allocating; retries have no client id and new ids collide with receipts.
        const reusableLaunchReceipt =
          input.threadId === undefined &&
          Option.isSome(launchReceipt) &&
          launchReceipt.value.status === "accepted" &&
          launchReceipt.value.commandType === "thread.create"
            ? launchReceipt.value
            : undefined;
        const candidateThreadId =
          input.threadId ??
          reusableLaunchReceipt?.threadId ??
          (yield* ids.allocate
            .thread({ projectId: input.projectId })
            .pipe(Effect.mapError(mapError(input, "create-thread"))));

        if (reusableLaunchReceipt !== undefined) {
          const shell = yield* threads
            .getThreadShell(candidateThreadId)
            .pipe(Effect.mapError(mapError(input, "create-thread", candidateThreadId)));
          if (shell === null) {
            return yield* mapError(input, "create-thread", candidateThreadId)("Thread not found.");
          }
          if (shell.projectId !== input.projectId) {
            return yield* mapError(
              input,
              "resolve-project",
              candidateThreadId,
            )("Project identity changed.");
          }
        }

        if (input.reuseExistingThread === true && Option.isNone(launchReceipt)) {
          yield* validateReusableThread(input, candidateThreadId);
        }

        let workspaceStrategy: ThreadLaunchWorkspaceStrategy =
          input.workspaceStrategy.type === "root" && Option.isNone(launchReceipt)
            ? Option.match(
                yield* managedFolders
                  .folderForThread({
                    projectId: input.projectId,
                    threadId: candidateThreadId,
                    text: input.initialMessage?.text ?? input.title,
                  })
                  .pipe(Effect.mapError(mapError(input, "provision-worktree", candidateThreadId))),
                {
                  onNone: () => input.workspaceStrategy,
                  onSome: (worktreePath) => ({ type: "existing_worktree", worktreePath }),
                },
              )
            : input.workspaceStrategy;
        let idleLab: import("@t3tools/contracts").LabsPrepareThreadResult | null = null;
        // An idle thread has no preparing run to hold its first send, so publish it after readiness.
        if (
          workspaceStrategy.type === "lab" &&
          input.initialMessage === undefined &&
          Option.isNone(launchReceipt)
        ) {
          const existing = yield* threads
            .getThreadShell(candidateThreadId)
            .pipe(Effect.mapError(mapError(input, "create-thread", candidateThreadId)));
          if (existing !== null) {
            return yield* mapError(
              input,
              "create-thread",
              candidateThreadId,
            )("An idle lab launch requires a new thread.");
          }
          idleLab = yield* labs
            .prepareAgentThread({
              ...workspaceStrategy,
              projectId: input.projectId,
              threadId: candidateThreadId,
            })
            .pipe(Effect.mapError(mapError(input, "prepare-lab", candidateThreadId)));
          const reserved = idleLab;
          yield* labs.startThread({ threadId: candidateThreadId, ...reserved }).pipe(
            Effect.onError(() =>
              labs.abandonThread(reserved).pipe(Effect.forkIn(preparationScope)),
            ),
            Effect.mapError(mapError(input, "start-lab", candidateThreadId)),
          );
          workspaceStrategy = {
            type: "existing_worktree",
            worktreePath: reserved.worktreePath,
            branch: reserved.branch,
          };
        }
        const initialBranch = yield* Effect.interruptible(
          launchBranch(workspaceStrategy, project.workspaceRoot),
        );
        const initialWorktreePath =
          workspaceStrategy.type === "existing_worktree" ? workspaceStrategy.worktreePath : null;
        const initialMessage =
          input.initialMessage === undefined
            ? undefined
            : {
                messageId:
                  input.initialMessage.messageId ??
                  (yield* ids.allocate
                    .message({ threadId: candidateThreadId, ordinal: 1 })
                    .pipe(Effect.mapError(mapError(input, "dispatch-message", candidateThreadId)))),
                text: input.initialMessage.text,
                ...(input.initialMessage.scheduledTaskId === undefined
                  ? {}
                  : { scheduledTaskId: input.initialMessage.scheduledTaskId }),
                ...(input.initialMessage.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: input.initialMessage.senderThreadId }),
                attachments: input.initialMessage.attachments,
                ...(input.initialMessage.context ? { context: input.initialMessage.context } : {}),
                ...(input.initialMessage.inputOrigin
                  ? { inputOrigin: input.initialMessage.inputOrigin }
                  : {}),
                ...(input.initialMessage.outputSchema === undefined
                  ? {}
                  : { outputSchema: input.initialMessage.outputSchema }),
                ...(input.generateTitle === true ? { titleSeed: input.title } : {}),
              };
        const claimDispatch =
          input.reuseExistingThread === true
            ? threads.dispatch({
                type: "thread.metadata.update",
                commandId: input.commandId,
                threadId: candidateThreadId,
                expectedEmpty: true,
              })
            : threads.dispatch({
                type: "thread.create",
                commandId: input.commandId,
                threadId: candidateThreadId,
                projectId: input.projectId,
                title: input.title,
                ...(input.titleRenamed === true ? { titleRenamed: true } : {}),
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                branch: initialBranch,
                worktreePath: initialWorktreePath,
                ...(input.importedNativeThread === undefined
                  ? {}
                  : { importedNativeThread: input.importedNativeThread }),
                ...(input.customGroupId == null ? {} : { customGroupId: input.customGroupId }),
                ...(input.linkOrigin === undefined ? {} : { linkOrigin: input.linkOrigin }),
                ...(input.delegatedFrom === undefined
                  ? {}
                  : { delegatedFrom: input.delegatedFrom }),
                ...(input.workflowRun === undefined ? {} : { workflowRun: input.workflowRun }),
                createdBy: input.createdBy,
                creationSource: input.creationSource,
                ...(initialMessage === undefined
                  ? {}
                  : { initialMessage: { ...initialMessage, workspaceStrategy } }),
              });
        const claimed = yield* claimDispatch.pipe(
          Effect.tapError(() => {
            const reserved = idleLab;
            return reserved === null
              ? Effect.void
              : threads.getThreadShell(candidateThreadId).pipe(
                  Effect.flatMap((shell) =>
                    shell?.worktreePath !== reserved.worktreePath
                      ? labs.abandonThread(reserved)
                      : Effect.void,
                  ),
                  Effect.ignore,
                  Effect.forkIn(preparationScope),
                );
          }),
          Effect.mapError(
            mapError(
              input,
              input.reuseExistingThread === true ? "update-thread" : "create-thread",
              candidateThreadId,
            ),
          ),
        );
        const threadId =
          claimed.storedEvents.find((stored) => stored.event.type.startsWith("thread."))?.event
            .threadId ?? candidateThreadId;
        const committedThread = yield* threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(mapError(input, "resolve-project", threadId)));
        if (committedThread?.projectId !== input.projectId) {
          return yield* mapError(input, "resolve-project", threadId)("Project identity changed.");
        }
        let runId: RunId | null = null;
        let messageSequence: number | undefined;
        let messageWasAlreadyAccepted = false;
        if (initialMessage !== undefined) {
          // A new thread's claim carries its first message. A reused thread, or a replayed
          // claim that carried none, takes it in a command of its own.
          let accepted = claimed;
          if (!claimed.storedEvents.some((stored) => stored.event.type === "run.created")) {
            const messageCommandId = CommandId.make(`${input.commandId}:initial-message`);
            const messageReceipt = yield* readReceipt(input, messageCommandId);
            messageWasAlreadyAccepted = Option.isSome(messageReceipt);
            accepted = yield* threads
              .dispatch({
                ...initialMessage,
                type: "message.dispatch",
                commandId: messageCommandId,
                threadId,
                modelSelection: input.modelSelection,
                dispatchMode: { type: "defer_start", workspaceStrategy },
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              })
              .pipe(
                // An agent's launch can land on a thread that a replay, or a concurrent
                // launch with the same key, created with broader modes. The orchestrator
                // refuses the message under the thread's lock; the user's own clients
                // launch into their own drafts, whatever modes those hold.
                input.createdBy === "agent"
                  ? Effect.provideService(DispatchModeLimit, {
                      runtimeMode: input.runtimeMode,
                      interactionMode: input.interactionMode,
                    })
                  : (effect) => effect,
                Effect.mapError(mapError(input, "dispatch-message", threadId)),
              );
          }
          // A concurrent retry can read no receipt and still replay the dispatch.
          messageWasAlreadyAccepted ||= accepted.replayed === true;
          messageSequence = accepted.sequence;
          const runCreated = accepted.storedEvents.find(
            (stored) => stored.event.type === "run.created",
          );
          runId = runCreated?.event.type === "run.created" ? runCreated.event.payload.id : null;
          if (runId === null) {
            return yield* mapError(
              input,
              "dispatch-message",
              threadId,
            )("Initial message was accepted without a durable run.");
          }
        }

        // Fork preparation before the full projection read; it is only part of the reply.
        const shouldSchedule = runId === null ? Option.isNone(launchReceipt) : true;
        if (shouldSchedule && (yield* reservePreparation(input.commandId))) {
          yield* Effect.gen(function* () {
            const current =
              runId === null
                ? null
                : yield* threads
                    .getThreadRecords(threadId, ["runs"], { runIds: [runId] })
                    .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
            if (
              current !== null &&
              !current.runs.some((run) => run.id === runId && run.status === "preparing")
            ) {
              return yield* releasePreparation(input.commandId);
            }
            const boundWorktreePath = current?.thread.worktreePath ?? null;
            // A retry prepares the worktree the accepted launch asked for, not the
            // retry's own strategy, whose defaults may resolve differently.
            const accepted = current?.runs.find((run) => run.id === runId)?.workspacePreparation;
            const preparationStrategy: ThreadLaunchWorkspaceStrategy =
              Option.isSome(launchReceipt) &&
              (accepted?.type === "worktree" || accepted?.type === "existing_worktree")
                ? accepted
                : Option.isSome(launchReceipt) &&
                    workspaceStrategy.type === "root" &&
                    boundWorktreePath !== null
                  ? {
                      type: "existing_worktree",
                      worktreePath: boundWorktreePath,
                      branch: workspaceStrategy.branch,
                    }
                  : workspaceStrategy;
            // The thread's link decides, as it does when preparation is retried: a request
            // that reuses a thread names none.
            const { linkOrigin: _requestLinkOrigin, ...preparation } = input;
            // The accepted run's message says who asked, as it does when preparation is
            // retried: a request that repeats the launch may name someone else.
            const acceptedRun = current?.runs.find((run) => run.id === runId);
            const acceptedMessages =
              acceptedRun === undefined
                ? null
                : (yield* threads
                    .getThreadRecords(threadId, ["messages"], {
                      messageIds: [acceptedRun.userMessageId],
                    })
                    .pipe(Effect.mapError(mapError(input, "update-thread", threadId)))).messages;
            const askedBy =
              current === null || acceptedRun === undefined || acceptedMessages === null
                ? input.createdBy === "agent"
                  ? { askedByAgent: { threadId: input.initialMessage?.senderThreadId } }
                  : {}
                : askedByAgent(
                    current.thread,
                    acceptedMessages.find((message) => message.id === acceptedRun.userMessageId),
                  );
            yield* schedulePreparation(
              {
                ...preparation,
                ...askedBy,
                workspaceStrategy: preparationStrategy,
                ...(committedThread.linkOrigin === undefined
                  ? {}
                  : { linkOrigin: committedThread.linkOrigin }),
              },
              threadId,
              runId,
            );
          }).pipe(Effect.onError(() => releasePreparation(input.commandId)));
        }
        const projection = yield* threads
          .getThreadProjection(threadId)
          .pipe(Effect.mapError(mapError(input, "create-thread", threadId)));

        return {
          threadId,
          projection,
          // An attempt that failed after claiming the thread recorded nothing, so
          // only a repeat of the final write counts as resumed.
          resumed:
            input.initialMessage === undefined
              ? Option.isSome(launchReceipt) || claimed.replayed === true
              : messageWasAlreadyAccepted,
          ...(messageSequence === undefined ? {} : { sequence: messageSequence }),
        };
      });
    },
    // The message commits a preparing run that only this call schedules, so a
    // caller that goes away must not stop the launch between the two.
    Effect.uninterruptible,
  );

  const prepareRun: ThreadLaunchService["Service"]["prepareRun"] = Effect.fn(
    "ThreadLaunchService.prepareRun",
  )(function* (input) {
    const scheduled = yield* Effect.gen(function* () {
      const { thread, runs } = yield* threads.getThreadRecords(input.threadId, ["runs"], {
        runIds: [input.runId],
      });
      const run = runs.find((candidate) => candidate.id === input.runId);
      const workspacePreparation = run?.workspacePreparation;
      if (run?.status !== "preparing" || workspacePreparation === undefined) return;
      if (!(yield* reservePreparation(input.commandId))) return;
      yield* scheduleRunPreparation(input, thread, run, workspacePreparation).pipe(
        Effect.onError(() => releasePreparation(input.commandId)),
      );
    }).pipe(Effect.exit);
    if (Exit.isFailure(scheduled)) {
      yield* failPreparedRun(
        input,
        input.threadId,
        input.runId,
        Cause.squash(scheduled.cause),
        false,
      );
    }
  });

  const retryPreparation: ThreadLaunchService["Service"]["retryPreparation"] = Effect.fn(
    "ThreadLaunchService.retryPreparation",
  )(function* (input) {
    const dispatched = yield* threads.dispatch({
      type: "prepared-run.retry",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: input.runId,
    });
    yield* prepareRun(input);
    return dispatched;
  });

  const scheduleRunPreparation = Effect.fn("ThreadLaunchService.scheduleRunPreparation")(function* (
    input: ThreadLaunchPreparationInput,
    thread: OrchestrationV2ThreadProjection["thread"],
    run: OrchestrationV2ThreadProjection["runs"][number],
    workspacePreparation: ThreadLaunchWorkspaceStrategy,
  ) {
    const { messages } = yield* threads.getThreadRecords(input.threadId, ["messages"], {
      messageIds: [run.userMessageId],
    });
    const message = messages.find((candidate) => candidate.id === run.userMessageId);
    const reuse =
      workspacePreparation.type === "worktree" &&
      thread.worktreePath !== null &&
      thread.branch !== null
        ? {
            strategy: {
              type: "existing_worktree" as const,
              worktreePath: thread.worktreePath,
              branch: thread.branch,
            },
            reusedWorktree: { baseRef: workspacePreparation.baseRef },
          }
        : null;
    return yield* schedulePreparation(
      {
        commandId: input.commandId,
        projectId: thread.projectId,
        workspaceStrategy: reuse?.strategy ?? workspacePreparation,
        ...(thread.linkOrigin === undefined ? {} : { linkOrigin: thread.linkOrigin }),
        ...askedByAgent(thread, message),
        ...(reuse === null ? {} : { reusedWorktree: reuse.reusedWorktree }),
        ...(message === undefined
          ? {}
          : {
              initialMessage: {
                text: message.text,
                attachments: message.attachments,
                ...(message.context ? { context: message.context } : {}),
                ...(run.outputSchema === undefined ? {} : { outputSchema: run.outputSchema }),
              },
            }),
      },
      input.threadId,
      run.id,
    );
  });

  return ThreadLaunchService.of({
    launch,
    checkWorktreeBase,
    isNonGitProject,
    retryPreparation,
    prepareRun,
  });
});

export const layer = Layer.effect(ThreadLaunchService, make);
