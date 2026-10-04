/**
 * SessionImportService — imports one Claude Code or Codex CLI session, created
 * outside T3 Code, as a new thread that continues the native session.
 *
 * The imported transcript is written as runless history (`historyOrigin:
 * "v1_import"`, like the bulk agent-session importer) and the thread's provider
 * thread holds a strong reference to the native session, so the first turn
 * resumes it natively and later forks/handoffs include the imported history.
 * A session another live thread already continues is only importable as a
 * native fork, so two threads never resume the same provider session.
 */
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ProjectId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type SessionImportCandidate,
  SessionImportError,
  type SessionImportLinkedThread,
  type SessionImportPayload,
  type SessionImportResult,
  type SessionImportWarning,
  ThreadId,
} from "@t3tools/contracts";
import { formatForkedThreadTitle } from "@t3tools/shared/composerTrigger";
import { validateProviderOptionSelectionsStrict } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { sanitizeGitRepositoryEnvironment } from "../git/Utils.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProcessRunner from "../processRunner.ts";
import { messageEvents } from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { extractSubstantiveUserText } from "../provider/Drivers/substantiveUserText.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderImportedMessage } from "./ProviderSessionImport.ts";

/** Bounds imported display history; the provider keeps the full transcript. */
export const SESSION_IMPORT_MAX_MESSAGES = 5_000;
const PREVIEW_MAX_CHARS = 120;
const TITLE_MAX_CHARS = 80;
const IMPORT_EVENT_PREFIX = "session-import:v2";
const GIT_TIMEOUT = Duration.seconds(30);
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

export type SessionImportInput = {
  readonly [K in keyof SessionImportPayload]: SessionImportPayload[K];
};

export interface SessionImportServiceShape {
  readonly listCandidates: (input: {
    readonly projectId: ProjectId;
    readonly cwd?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<SessionImportCandidate>, SessionImportError>;
  /** Optional fields accept `undefined` so a decoded transport payload forwards verbatim. */
  readonly importSession: (
    input: SessionImportInput,
  ) => Effect.Effect<SessionImportResult, SessionImportError>;
}

export class SessionImportService extends Context.Service<
  SessionImportService,
  SessionImportServiceShape
>()("t3/sessionImport/SessionImportService") {}

const failure = (reason: SessionImportError["reason"], detail: string, cause?: unknown) =>
  new SessionImportError({ reason, detail, ...(cause === undefined ? {} : { cause }) });

function normalizedTitle(seed: string): string | null {
  const singleLine = seed.trim().split("\n")[0]?.trim() ?? "";
  const truncated = singleLine.slice(0, TITLE_MAX_CHARS).trim();
  return truncated.length > 0 ? truncated : null;
}

/** An explicit provider name wins, then the first substantive user message. */
export function titleForImport(
  name: string | null,
  messages: ReadonlyArray<ProviderImportedMessage>,
): string {
  const nativeTitle = name?.trim();
  if (nativeTitle) return nativeTitle.slice(0, TITLE_MAX_CHARS);
  let substantive: string | null = null;
  for (const message of messages) {
    if (message.role !== "user") continue;
    substantive = extractSubstantiveUserText(message.text);
    if (substantive !== null) break;
  }
  const firstUser = messages.find((message) => message.role === "user")?.text;
  return normalizedTitle(substantive ?? firstUser ?? messages[0]?.text ?? "") ?? "Imported session";
}

function continuationKeyOf(
  instances: ReadonlyArray<ProviderInstance>,
  driver: string,
  instanceId: string,
): string {
  return (
    instances.find((instance) => instance.instanceId === instanceId)?.continuationIdentity
      .continuationKey ?? `${driver}:instance:${instanceId}`
  );
}

interface NativeSessionOwner {
  readonly threadId: ThreadId;
  readonly nativeId: string;
  readonly continuationKey: string;
  readonly active: boolean;
}

export const make = Effect.gen(function* () {
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const processRunner = yield* ProcessRunner.make();
  const importSemaphore = yield* Semaphore.make(1);

  const resolveWorkspaceRoot = Effect.fn("SessionImportService.resolveWorkspaceRoot")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .getById(projectId)
      .pipe(
        Effect.mapError((cause) =>
          failure("project-not-found", `Failed to load project '${projectId}'.`, cause),
        ),
      );
    if (Option.isNone(project)) {
      return yield* failure("project-not-found", `Project '${projectId}' was not found.`);
    }
    return yield* fileSystem
      .realPath(project.value.workspaceRoot)
      .pipe(Effect.orElseSucceed(() => project.value.workspaceRoot));
  });

  const runGit = Effect.fn("SessionImportService.runGit")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* processRunner
      .run({
        command: "git",
        args,
        cwd,
        env: {
          ...sanitizeGitRepositoryEnvironment(),
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
        timeout: GIT_TIMEOUT,
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      })
      .pipe(Effect.mapError((cause) => failure("invalid-worktree", cause.message, cause)));
    const exitCode = result.code === null ? -1 : Number(result.code);
    if (exitCode !== 0) {
      return yield* failure(
        "invalid-worktree",
        result.stderr.trim() || `git exited with code ${exitCode}`,
      );
    }
    return result.stdout.trim();
  });

  const gitCommonDirectory = Effect.fn("SessionImportService.gitCommonDirectory")(function* (
    cwd: string,
  ) {
    const raw = yield* runGit(cwd, ["rev-parse", "--git-common-dir"]);
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    return yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
  });

  /** An existing worktree of the project's repository, optionally on `expectedBranch`. */
  const validateWorktree = Effect.fn("SessionImportService.validateWorktree")(function* (
    workspaceRoot: string,
    rawWorktreePath: string,
    expectedBranch?: string,
  ) {
    const worktreePath = rawWorktreePath.trim();
    const info = yield* fileSystem
      .stat(worktreePath)
      .pipe(
        Effect.mapError((cause) =>
          failure("invalid-worktree", `Worktree path '${worktreePath}' does not exist.`, cause),
        ),
      );
    if (info.type !== "Directory") {
      return yield* failure(
        "invalid-worktree",
        `Worktree path '${worktreePath}' is not a directory.`,
      );
    }
    const canonicalPath = yield* fileSystem
      .realPath(worktreePath)
      .pipe(
        Effect.mapError((cause) =>
          failure("invalid-worktree", `Failed to canonicalize '${worktreePath}'.`, cause),
        ),
      );
    const [projectGitDirectory, worktreeGitDirectory] = yield* Effect.all(
      [gitCommonDirectory(workspaceRoot), gitCommonDirectory(canonicalPath)],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) =>
        failure(
          "invalid-worktree",
          `Worktree path '${canonicalPath}' is not a git worktree for this project.`,
          cause,
        ),
      ),
    );
    if (projectGitDirectory !== worktreeGitDirectory) {
      return yield* failure(
        "invalid-worktree",
        `Worktree path '${canonicalPath}' belongs to a different git repository.`,
      );
    }
    const branch = yield* runGit(canonicalPath, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]).pipe(
      Effect.mapError((cause) =>
        failure("invalid-worktree", `Worktree path '${canonicalPath}' has a detached HEAD.`, cause),
      ),
    );
    if (expectedBranch !== undefined && branch !== expectedBranch) {
      return yield* failure(
        "invalid-worktree",
        `Worktree path '${canonicalPath}' is on branch '${branch}', not '${expectedBranch}'.`,
      );
    }
    return { branch, worktreePath: canonicalPath };
  });

  /**
   * Live threads whose root provider thread holds a native session of `driver`.
   * A thread keeps owning a session after switching away from it, since
   * switching back resumes it.
   */
  const readNativeSessionOwners = Effect.fn("SessionImportService.readNativeSessionOwners")(
    function* (instances: ReadonlyArray<ProviderInstance>, driver: ProviderDriverKind) {
      const rows = yield* sql<{
        readonly thread_id: string;
        readonly native_id: string;
        readonly provider_instance_id: string;
        readonly active: number;
      }>`
        SELECT
          p.thread_id,
          json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
          p.provider_instance_id,
          CASE WHEN t.active_provider_thread_id = p.provider_thread_id THEN 1 ELSE 0 END AS active
        FROM orchestration_v2_projection_provider_threads p
        JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
        WHERE p.driver = ${driver}
          AND p.owner_node_id IS NULL
          AND t.deleted_at IS NULL
          AND json_extract(p.payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
      `.pipe(
        Effect.mapError((cause) =>
          failure("import-failed", "Failed to read existing provider sessions.", cause),
        ),
      );
      return rows.map((row): NativeSessionOwner => ({
        threadId: ThreadId.make(row.thread_id),
        nativeId: row.native_id,
        continuationKey: continuationKeyOf(instances, driver, row.provider_instance_id),
        active: row.active === 1,
      }));
    },
  );

  /** The thread that continues `nativeId` in `instance`'s session home, if any. */
  const findOwnerThread = (
    owners: ReadonlyArray<NativeSessionOwner>,
    instance: ProviderInstance,
    nativeId: string,
  ): ThreadId | undefined => {
    const matching = owners.filter(
      (owner) =>
        owner.nativeId === nativeId &&
        owner.continuationKey === instance.continuationIdentity.continuationKey,
    );
    return (matching.find((owner) => owner.active) ?? matching[0])?.threadId;
  };

  const readLinkedThread = Effect.fn("SessionImportService.readLinkedThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* orchestrator
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError((cause) =>
          failure("import-failed", `Failed to read thread '${threadId}'.`, cause),
        ),
      );
    return shell;
  });

  const listCandidates: SessionImportServiceShape["listCandidates"] = Effect.fn(
    "SessionImportService.listCandidates",
  )(function* (input) {
    const workspaceRoot = yield* resolveWorkspaceRoot(input.projectId);
    const cwd =
      input.cwd === undefined
        ? workspaceRoot
        : (yield* validateWorktree(workspaceRoot, input.cwd)).worktreePath;
    const instances = yield* instanceRegistry.listInstances;
    const ownersByDriver = new Map<ProviderDriverKind, ReadonlyArray<NativeSessionOwner>>();
    const candidates: Array<SessionImportCandidate> = [];
    for (const instance of instances) {
      if (!instance.enabled || instance.sessionImport === undefined) continue;
      const sessions = yield* instance.sessionImport
        .listSessions({ cwd })
        .pipe(
          Effect.mapError((cause) =>
            failure(
              "provider-read-failed",
              `Listing importable ${instance.driverKind} sessions failed: ${cause.detail}`,
              cause,
            ),
          ),
        );
      if (sessions.length === 0) continue;
      const owners =
        ownersByDriver.get(instance.driverKind) ??
        (yield* readNativeSessionOwners(instances, instance.driverKind));
      ownersByDriver.set(instance.driverKind, owners);
      const providerDisplayName =
        instance.displayName ??
        (yield* instance.snapshot.getSnapshot).displayName ??
        instance.driverKind;
      for (const session of sessions) {
        const ownerThreadId = findOwnerThread(owners, instance, session.nativeSessionId);
        const owner = ownerThreadId === undefined ? null : yield* readLinkedThread(ownerThreadId);
        const linkedThread: SessionImportLinkedThread | null =
          owner === null
            ? null
            : {
                threadId: owner.id,
                title: owner.title,
                archivedAt: owner.archivedAt === null ? null : DateTime.formatIso(owner.archivedAt),
                updatedAt: DateTime.formatIso(owner.updatedAt),
                canFork: instance.sessionImport.forkSession !== undefined,
              };
        candidates.push({
          instanceId: instance.instanceId,
          provider: instance.driverKind,
          providerDisplayName,
          nativeSessionId: session.nativeSessionId,
          name: session.name === null ? null : session.name.slice(0, PREVIEW_MAX_CHARS),
          preview: session.preview.slice(0, PREVIEW_MAX_CHARS),
          messageCount: session.messageCount,
          updatedAt: session.updatedAt,
          linkedThread,
        });
      }
    }
    candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return candidates;
  });

  const resolveModelSelection = Effect.fn("SessionImportService.resolveModelSelection")(
    function* (input: {
      readonly instance: ProviderInstance;
      readonly importedModel: string | null;
      readonly override: ModelSelection | undefined;
    }) {
      const snapshot = yield* input.instance.snapshot.getSnapshot;
      const override = input.override;
      if (override !== undefined) {
        if (override.instanceId !== input.instance.instanceId) {
          return yield* failure(
            "invalid-options",
            `Model selection instance '${override.instanceId}' does not match import instance '${input.instance.instanceId}'.`,
          );
        }
        const advertised = snapshot.models.find((model) => model.slug === override.model);
        if (advertised === undefined) {
          return yield* failure(
            "invalid-model",
            `Model '${override.model}' is not advertised by provider instance '${input.instance.instanceId}'.`,
          );
        }
        const validationError = validateProviderOptionSelectionsStrict({
          descriptors: advertised.capabilities?.optionDescriptors ?? [],
          selections: override.options ?? [],
        });
        if (validationError !== null) {
          return yield* failure("invalid-options", validationError.detail);
        }
        return override;
      }
      const knownSlugs = new Set(snapshot.models.map((model) => model.slug));
      const providerDefault = DEFAULT_MODEL_BY_PROVIDER[input.instance.driverKind];
      const fallback =
        (providerDefault !== undefined && knownSlugs.has(providerDefault)
          ? providerDefault
          : undefined) ??
        snapshot.models.find((model) => model.isCustom !== true)?.slug ??
        snapshot.models[0]?.slug ??
        providerDefault;
      const model =
        input.importedModel !== null && knownSlugs.has(input.importedModel)
          ? input.importedModel
          : (fallback ?? input.importedModel);
      if (model === null || model === undefined || model.length === 0) {
        return yield* failure(
          "instance-not-found",
          `Provider instance '${input.instance.instanceId}' has no usable model for the imported session.`,
        );
      }
      return { instanceId: input.instance.instanceId, model } satisfies ModelSelection;
    },
  );

  /** Shares the bulk importer's id, so either import path sees the other's thread. */
  const allocateThreadId = Effect.fn("SessionImportService.allocateThreadId")(function* (
    instanceId: ProviderInstanceId,
    nativeId: string,
  ) {
    const deterministic = ThreadId.make(`import:${instanceId}:${nativeId}`);
    const existing = yield* Effect.option(orchestrator.getThreadRecords(deterministic, []));
    if (Option.isNone(existing)) return deterministic;
    // Taken by a deleted import of the same session.
    const uuid = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        failure("import-failed", "Failed to allocate an id for the imported thread.", cause),
      ),
    );
    return ThreadId.make(uuid);
  });

  const importSessionUnlocked = Effect.fn("SessionImportService.importSession")(function* (
    input: SessionImportInput,
  ) {
    const workspaceRoot = yield* resolveWorkspaceRoot(input.projectId);
    const instance = yield* instanceRegistry.getInstance(input.instanceId);
    if (instance === undefined || !instance.enabled) {
      return yield* failure(
        "instance-not-found",
        `Provider instance '${input.instanceId}' is not available.`,
      );
    }
    const sessionImport = instance.sessionImport;
    if (sessionImport === undefined) {
      return yield* failure(
        "instance-not-found",
        `Provider instance '${input.instanceId}' does not support session import.`,
      );
    }
    const instances = yield* instanceRegistry.listInstances;
    const ownerThreadId = findOwnerThread(
      yield* readNativeSessionOwners(instances, instance.driverKind),
      instance,
      input.nativeSessionId,
    );
    const owner = ownerThreadId === undefined ? null : yield* readLinkedThread(ownerThreadId);
    if (owner !== null && input.fork !== true) {
      return yield* new SessionImportError({
        reason: "already-imported",
        detail: `Session '${input.nativeSessionId}' is already attached to a T3 Code thread.`,
        existingThreadId: owner.id,
      });
    }
    const worktree =
      input.worktree === undefined
        ? undefined
        : yield* validateWorktree(
            workspaceRoot,
            input.worktree.worktreePath,
            input.worktree.branch,
          );
    const cwd = worktree?.worktreePath ?? workspaceRoot;

    const history = yield* sessionImport
      .readSession({ nativeSessionId: input.nativeSessionId, cwd })
      .pipe(
        Effect.mapError((cause) =>
          failure(
            "provider-read-failed",
            `Reading ${instance.driverKind} session '${input.nativeSessionId}' failed: ${cause.detail}`,
            cause,
          ),
        ),
      );
    if (history.messages.length === 0) {
      return yield* failure(
        "nothing-to-import",
        `Session '${input.nativeSessionId}' contains no importable messages.`,
      );
    }
    const warnings: Array<SessionImportWarning> = [];
    const importedMessages = history.messages.slice(-SESSION_IMPORT_MAX_MESSAGES);
    if (importedMessages.length !== history.messages.length) {
      warnings.push({
        code: "history-truncated",
        message: `Imported the most recent ${SESSION_IMPORT_MAX_MESSAGES} of ${history.messages.length} messages; the provider session retains the full history.`,
      });
    }
    const modelSelection = yield* resolveModelSelection({
      instance,
      importedModel: history.model,
      override: input.modelSelection,
    });

    let nativeId = history.nativeSessionId;
    let defaultTitle = titleForImport(history.name, importedMessages);
    if (owner !== null) {
      if (sessionImport.forkSession === undefined) {
        return yield* new SessionImportError({
          reason: "fork-unsupported",
          detail: `Provider instance '${input.instanceId}' does not support forking imported sessions.`,
          existingThreadId: owner.id,
        });
      }
      if (owner.activeRunId !== null) {
        return yield* failure(
          "import-failed",
          `Cannot import this session as a fork while thread '${owner.title}' is running. Retry when it finishes.`,
        );
      }
      nativeId = yield* sessionImport
        .forkSession({ nativeSessionId: input.nativeSessionId, cwd })
        .pipe(Effect.mapError((cause) => failure("import-failed", cause.detail, cause)));
      defaultTitle = formatForkedThreadTitle(owner.title);
    }

    const threadId = yield* allocateThreadId(instance.instanceId, nativeId);
    const now = yield* DateTime.now;
    const driver = instance.driverKind;
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      providerInstanceId: instance.instanceId,
      nativeThreadId: nativeId,
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "server",
      id: threadId,
      projectId: input.projectId,
      title: input.title?.trim() || defaultTitle,
      providerInstanceId: instance.instanceId,
      modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: worktree?.branch ?? null,
      worktreePath: worktree?.worktreePath ?? null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThreadId,
      historyOrigin: "v1_import",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: instance.instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt: now,
      updatedAt: now,
    };
    const nowIso = DateTime.formatIso(now);
    yield* eventSink
      .write({
        events: [
          {
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
            type: "thread.created",
            threadId,
            providerInstanceId: instance.instanceId,
            occurredAt: now,
            payload: thread,
          },
          ...importedMessages.flatMap((message, index) =>
            messageEvents({
              threadId,
              index,
              // Providers may omit a timestamp; keep the message, stamped now.
              message: Option.isSome(DateTime.make(message.createdAt))
                ? message
                : { ...message, createdAt: nowIso },
            }),
          ),
          {
            id: EventId.make(
              `${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}:${threadId}`,
            ),
            type: "provider-thread.updated",
            threadId,
            driver,
            providerInstanceId: instance.instanceId,
            occurredAt: now,
            payload: providerThread,
          },
        ],
      })
      .pipe(
        Effect.mapError((cause) =>
          failure(
            "import-failed",
            `Importing session '${input.nativeSessionId}' failed while persisting the thread.`,
            cause,
          ),
        ),
      );
    return {
      threadId,
      ...(warnings.length === 0 ? {} : { warnings }),
    } satisfies SessionImportResult;
  });

  // Checking whether a native session is already owned and creating its thread
  // are separate steps, so duplicate requests are serialized.
  const importSession: SessionImportServiceShape["importSession"] = (input) =>
    importSemaphore.withPermits(1)(importSessionUnlocked(input));

  return { listCandidates, importSession } satisfies SessionImportServiceShape;
});

export const layer = Layer.effect(SessionImportService, make);
