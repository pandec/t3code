/**
 * SessionImportService — imports Claude Code / Codex CLI sessions created
 * outside t3code as new t3 threads.
 *
 * Flow per import: read native history through the provider adapter, fork it
 * first when another live thread owns the continuation, write the provider
 * binding, then dispatch the `thread.import` orchestration command. On dispatch
 * failure the binding is compensated (deleted) so the import remains retryable.
 */
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type SessionImportCandidate,
  SessionImportError,
  type SessionImportWarning,
  ThreadId,
  type ThreadImportMessage,
  THREAD_IMPORT_MAX_MESSAGES,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Crypto from "effect/Crypto";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { formatForkedThreadTitle } from "@t3tools/shared/composerTrigger";
import { validateProviderOptionSelectionsStrict } from "@t3tools/shared/model";

import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { sanitizeGitRepositoryEnvironment } from "../git/Utils.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import {
  type ProjectionThread,
  ProjectionThreadRepository,
} from "../persistence/Services/ProjectionThreads.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { readPersistedContinuationKey } from "../provider/runtimeBindingContinuation.ts";
import { extractSubstantiveUserText } from "../provider/Drivers/substantiveUserText.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";

class SessionImportGitError extends Schema.TaggedErrorClass<SessionImportGitError>()(
  "SessionImportGitError",
  {
    detail: Schema.String,
  },
) {}

export interface SessionImportResult {
  readonly threadId: ThreadId;
  readonly warnings?: ReadonlyArray<SessionImportWarning>;
}

export interface SessionImportServiceShape {
  readonly listCandidates: (input: {
    readonly projectId: ProjectId;
    readonly cwd?: string;
  }) => Effect.Effect<ReadonlyArray<SessionImportCandidate>, SessionImportError>;
  readonly importSession: (input: {
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
    readonly nativeSessionId: string;
    // Optionals accept `undefined` so a decoded transport payload forwards
    // verbatim instead of being re-listed field by field at each boundary.
    readonly title?: string | undefined;
    readonly fork?: boolean | undefined;
    readonly modelSelection?: ModelSelection | undefined;
    readonly worktree?:
      | {
          readonly branch: string;
          readonly worktreePath: string;
        }
      | undefined;
  }) => Effect.Effect<SessionImportResult, SessionImportError>;
}

export class SessionImportService extends Context.Service<
  SessionImportService,
  SessionImportServiceShape
>()("t3/sessionImport/SessionImportService") {}

const PREVIEW_MAX_CHARS = 120;
const TITLE_MAX_CHARS = 80;
const SESSION_IMPORT_GIT_TIMEOUT = Duration.seconds(30);
const SESSION_IMPORT_GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

function importMessageId(threadId: ThreadId, index: number) {
  return MessageId.make(`import:${threadId}:${String(index).padStart(5, "0")}`);
}

function normalizedTitle(seed: string): string | null {
  const singleLine = seed.trim().split("\n")[0]?.trim() ?? "";
  const truncated = singleLine.slice(0, TITLE_MAX_CHARS).trim();
  return truncated.length > 0 ? truncated : null;
}

function titleForImport(
  name: string | null,
  messages: ReadonlyArray<{ role: string; text: string }>,
): string {
  const nativeTitle = name?.trim();
  if (nativeTitle) return nativeTitle;
  const firstUser = messages.find((message) => message.role === "user")?.text;
  let substantiveUserText: string | null = null;
  for (const message of messages) {
    if (message.role !== "user") continue;
    substantiveUserText = extractSubstantiveUserText(message.text);
    if (substantiveUserText !== null) break;
  }
  return (
    normalizedTitle(substantiveUserText ?? firstUser ?? messages[0]?.text ?? "") ??
    "Imported session"
  );
}

/** Native session ids already attached to a t3 thread via a resume cursor. */
function nativeIdsFromCursor(resumeCursor: unknown): ReadonlyArray<string> {
  if (resumeCursor === null || typeof resumeCursor !== "object") return [];
  const cursor = resumeCursor as { resume?: unknown; sessionId?: unknown; threadId?: unknown };
  const ids: Array<string> = [];
  if (typeof cursor.resume === "string") ids.push(cursor.resume);
  if (typeof cursor.sessionId === "string") ids.push(cursor.sessionId);
  if (typeof cursor.threadId === "string") ids.push(cursor.threadId);
  return ids;
}

export const makeSessionImportService = Effect.gen(function* () {
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const projectRepository = yield* ProjectionProjectRepository;
  const threadRepository = yield* ProjectionThreadRepository;
  const runtimeRepository = yield* ProviderSessionRuntimeRepository;
  const sessionDirectory = yield* ProviderSessionDirectory;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const importSemaphore = yield* Semaphore.make(1);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const resolveProjectWorkspaceRoot = Effect.fn("resolveProjectWorkspaceRoot")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectRepository.getById({ projectId }).pipe(
      Effect.mapError(
        (cause) =>
          new SessionImportError({
            reason: "project-not-found",
            detail: `Failed to load project '${projectId}'.`,
            cause,
          }),
      ),
    );
    if (Option.isNone(project) || project.value.deletedAt !== null) {
      return yield* new SessionImportError({
        reason: "project-not-found",
        detail: `Project '${projectId}' was not found.`,
      });
    }
    const workspaceRoot = yield* fileSystem
      .realPath(project.value.workspaceRoot)
      .pipe(Effect.orElseSucceed(() => project.value.workspaceRoot));
    return { project: project.value, workspaceRoot };
  });

  const listBoundThreadsByInstance = Effect.fn("listBoundThreadsByInstance")(function* (
    instances: ReadonlyArray<ProviderInstance>,
  ) {
    const bindings = yield* runtimeRepository.list().pipe(
      Effect.mapError(
        (cause) =>
          new SessionImportError({
            reason: "import-failed",
            detail: "Failed to read existing provider session bindings.",
            cause,
          }),
      ),
    );
    const continuationKeyByInstance = new Map<string, string>(
      instances.map((instance) => [
        instance.instanceId,
        instance.continuationIdentity?.continuationKey ??
          `provider-instance:${instance.instanceId}`,
      ]),
    );
    // Every bound thread id is kept per native id: stale binding rows are
    // never hard-deleted (thread deletion is a soft `deletedAt`), and the
    // repository lists oldest first, so a single-winner map would let a stale
    // row shadow the live binding created by a later re-import.
    const idsByContinuationKey = new Map<string, Map<string, Array<ThreadId>>>();
    for (const binding of bindings) {
      // Legacy rows without an explicit instance id belong to the default
      // instance, whose id is the provider/driver name.
      const ownerInstanceId = binding.providerInstanceId ?? binding.providerName;
      const continuationKey =
        readPersistedContinuationKey(binding.runtimePayload) ??
        continuationKeyByInstance.get(ownerInstanceId) ??
        `provider-instance:${ownerInstanceId}`;
      const ids = idsByContinuationKey.get(continuationKey) ?? new Map<string, Array<ThreadId>>();
      for (const id of nativeIdsFromCursor(binding.resumeCursor)) {
        const threadIds = ids.get(id) ?? [];
        if (!threadIds.includes(binding.threadId)) threadIds.push(binding.threadId);
        ids.set(id, threadIds);
      }
      if (ids.size > 0) {
        idsByContinuationKey.set(continuationKey, ids);
      }
    }
    const idsByInstance = new Map<string, Map<string, Array<ThreadId>>>();
    for (const instance of instances) {
      const continuationKey =
        instance.continuationIdentity?.continuationKey ??
        `provider-instance:${instance.instanceId}`;
      const ids = idsByContinuationKey.get(continuationKey);
      if (ids !== undefined) idsByInstance.set(instance.instanceId, ids);
    }
    return idsByInstance;
  });

  const makeReadThread = () => {
    const threadById = new Map<ThreadId, Option.Option<ProjectionThread>>();
    return Effect.fn("SessionImportService.readBoundThread")(function* (threadId: ThreadId) {
      const cached = threadById.get(threadId);
      if (cached !== undefined) return cached;
      const thread = yield* threadRepository.getById({ threadId }).pipe(
        Effect.mapError(
          (cause) =>
            new SessionImportError({
              reason: "import-failed",
              detail: `Failed to read thread '${threadId}' for an existing provider session binding.`,
              cause,
            }),
        ),
      );
      threadById.set(threadId, thread);
      return thread;
    });
  };

  /**
   * Resolves which bound thread currently owns a native session: the first
   * whose projection is live. The remaining ids are stale (deleted or missing
   * threads) but may still hold a shutting-down provider session.
   */
  const resolveBoundThreads = Effect.fn("SessionImportService.resolveBoundThreads")(function* (
    readThread: ReturnType<typeof makeReadThread>,
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    let liveThread: ProjectionThread | undefined;
    const staleThreadIds: Array<ThreadId> = [];
    for (const threadId of threadIds) {
      const thread = Option.getOrUndefined(yield* readThread(threadId));
      if (liveThread === undefined && thread !== undefined && thread.deletedAt === null) {
        liveThread = thread;
      } else {
        staleThreadIds.push(threadId);
      }
    }
    return { liveThread, staleThreadIds };
  });

  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.make();

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
        timeout: SESSION_IMPORT_GIT_TIMEOUT,
        maxOutputBytes: SESSION_IMPORT_GIT_MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SessionImportGitError({
              detail: cause.message,
            }),
        ),
      );
    const exitCode = result.code === null ? -1 : Number(result.code);
    if (exitCode !== 0) {
      return yield* new SessionImportGitError({
        detail: result.stderr.trim() || `git exited with code ${exitCode}`,
      });
    }
    return result.stdout.trim();
  });

  const invalidWorktree = (detail: string, cause?: unknown) =>
    new SessionImportError({
      reason: "invalid-worktree",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const resolveGitCommonDirectory = Effect.fn("SessionImportService.resolveGitCommonDirectory")(
    function* (cwd: string) {
      const raw = yield* runGit(cwd, ["rev-parse", "--git-common-dir"]);
      const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
      return yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
    },
  );

  const validateWorktreeCwd = Effect.fn("SessionImportService.validateWorktreeCwd")(function* (
    workspaceRoot: string,
    rawWorktreePath: string,
    expectedBranch?: string,
  ) {
    const worktreePath = rawWorktreePath.trim();
    if (worktreePath.length === 0) {
      return yield* invalidWorktree("Worktree path cannot be empty.");
    }
    const info = yield* fileSystem
      .stat(worktreePath)
      .pipe(
        Effect.mapError((cause) =>
          invalidWorktree(`Worktree path '${worktreePath}' does not exist.`, cause),
        ),
      );
    if (info.type !== "Directory") {
      return yield* invalidWorktree(`Worktree path '${worktreePath}' is not a directory.`);
    }
    const canonicalWorktreePath = yield* fileSystem
      .realPath(worktreePath)
      .pipe(
        Effect.mapError((cause) =>
          invalidWorktree(`Failed to canonicalize worktree path '${worktreePath}'.`, cause),
        ),
      );
    const [projectGitDirectory, worktreeGitDirectory] = yield* Effect.all(
      [resolveGitCommonDirectory(workspaceRoot), resolveGitCommonDirectory(canonicalWorktreePath)],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) =>
        invalidWorktree(
          `Worktree path '${canonicalWorktreePath}' is not a git worktree for this project.`,
          cause,
        ),
      ),
    );
    if (projectGitDirectory !== worktreeGitDirectory) {
      return yield* invalidWorktree(
        `Worktree path '${canonicalWorktreePath}' belongs to a different git repository.`,
      );
    }
    const branch = yield* runGit(canonicalWorktreePath, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]).pipe(
      Effect.mapError((cause) =>
        invalidWorktree(`Worktree path '${canonicalWorktreePath}' has a detached HEAD.`, cause),
      ),
    );
    if (expectedBranch !== undefined && branch !== expectedBranch) {
      return yield* invalidWorktree(
        `Worktree path '${canonicalWorktreePath}' is on branch '${branch}', not '${expectedBranch}'.`,
      );
    }
    return { branch, worktreePath: canonicalWorktreePath };
  });

  const listCandidates: SessionImportServiceShape["listCandidates"] = Effect.fn(
    "SessionImportService.listCandidates",
  )(function* (input) {
    const { workspaceRoot } = yield* resolveProjectWorkspaceRoot(input.projectId);
    const instances = yield* instanceRegistry.listInstances;
    const boundThreadsByInstance = yield* listBoundThreadsByInstance(instances);
    const readThread = makeReadThread();
    const effectiveCwd =
      input.cwd === undefined
        ? workspaceRoot
        : (yield* validateWorktreeCwd(workspaceRoot, input.cwd)).worktreePath;
    const candidates: Array<SessionImportCandidate> = [];
    for (const instance of instances) {
      if (!instance.enabled) continue;
      const listImportable = instance.adapter.listImportableSessions;
      if (listImportable === undefined) continue;
      let providerDisplayName = instance.displayName;
      if (providerDisplayName === undefined) {
        const snapshot = yield* instance.snapshot.getSnapshot;
        providerDisplayName = snapshot.displayName ?? instance.driverKind;
      }
      const boundThreads = boundThreadsByInstance.get(instance.instanceId);
      const sessions = yield* listImportable({ cwd: effectiveCwd }).pipe(
        Effect.mapError(
          (cause) =>
            new SessionImportError({
              reason: "provider-read-failed",
              detail: `Listing importable ${instance.driverKind} sessions failed: ${
                typeof cause === "object" && cause !== null && "detail" in cause
                  ? String((cause as { detail: unknown }).detail)
                  : String(cause)
              }`,
              cause,
            }),
        ),
      );
      for (const session of sessions) {
        const boundThreadIds = boundThreads?.get(session.nativeSessionId) ?? [];
        const { liveThread: linkedThread } = yield* resolveBoundThreads(readThread, boundThreadIds);
        candidates.push({
          instanceId: instance.instanceId,
          provider: instance.driverKind,
          providerDisplayName,
          nativeSessionId: session.nativeSessionId,
          name: session.name !== null ? session.name.slice(0, PREVIEW_MAX_CHARS) : null,
          preview: session.preview.slice(0, PREVIEW_MAX_CHARS),
          messageCount: session.messageCount,
          updatedAt: session.updatedAt,
          linkedThread:
            linkedThread === undefined
              ? null
              : {
                  threadId: linkedThread.threadId,
                  title: linkedThread.title,
                  archivedAt: linkedThread.archivedAt,
                  updatedAt: linkedThread.updatedAt,
                  canFork: instance.adapter.forkSession !== undefined,
                },
        });
      }
    }
    candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return candidates;
  });

  const resolveModelSelection = Effect.fn("resolveModelSelection")(function* (input: {
    readonly instance: ProviderInstance;
    readonly importedModel: string | null;
    readonly override?: ModelSelection;
  }) {
    const snapshot = yield* input.instance.snapshot.getSnapshot;
    if (input.override !== undefined) {
      if (input.override.instanceId !== input.instance.instanceId) {
        return yield* new SessionImportError({
          reason: "invalid-options",
          detail: `Model selection instance '${input.override.instanceId}' does not match import instance '${input.instance.instanceId}'.`,
        });
      }
      const advertisedModel = snapshot.models.find((model) => model.slug === input.override?.model);
      if (advertisedModel === undefined) {
        return yield* new SessionImportError({
          reason: "invalid-model",
          detail: `Model '${input.override.model}' is not advertised by provider instance '${input.instance.instanceId}'.`,
        });
      }
      const validationError = validateProviderOptionSelectionsStrict({
        descriptors: advertisedModel.capabilities?.optionDescriptors ?? [],
        selections: input.override.options ?? [],
      });
      if (validationError !== null) {
        return yield* new SessionImportError({
          reason: "invalid-options",
          detail: validationError.detail,
        });
      }
      return input.override;
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
      return yield* new SessionImportError({
        reason: "instance-not-found",
        detail: `Provider instance '${input.instance.instanceId}' has no usable model for the imported session.`,
      });
    }
    return { instanceId: input.instance.instanceId, model } satisfies ModelSelection;
  });

  const importSessionUnlocked: SessionImportServiceShape["importSession"] = Effect.fn(
    "SessionImportService.importSessionUnlocked",
  )(function* (input) {
    const { workspaceRoot } = yield* resolveProjectWorkspaceRoot(input.projectId);
    const instances = yield* instanceRegistry.listInstances;
    const boundThreadsByInstance = yield* listBoundThreadsByInstance(instances);
    const readThread = makeReadThread();
    const boundThreadIds =
      boundThreadsByInstance.get(input.instanceId)?.get(input.nativeSessionId) ?? [];

    const instance = yield* instanceRegistry.getInstance(input.instanceId);
    if (instance === undefined || !instance.enabled) {
      return yield* new SessionImportError({
        reason: "instance-not-found",
        detail: `Provider instance '${input.instanceId}' is not available.`,
      });
    }
    const readImportable = instance.adapter.readImportableSession;
    if (readImportable === undefined) {
      return yield* new SessionImportError({
        reason: "instance-not-found",
        detail: `Provider instance '${input.instanceId}' does not support session import.`,
      });
    }

    const { liveThread: linkedThread, staleThreadIds } = yield* resolveBoundThreads(
      readThread,
      boundThreadIds,
    );
    const existingThreadId = linkedThread?.threadId;
    if (linkedThread === undefined) {
      // A stale binding's thread is gone, but its provider session may still
      // be shutting down (thread deletion cleanup is asynchronous and stop
      // failures are swallowed); binding a new thread to the same native
      // session then risks two live processes on one provider session.
      for (const staleThreadId of staleThreadIds) {
        if (yield* instance.adapter.hasSession(staleThreadId)) {
          return yield* new SessionImportError({
            reason: "import-failed",
            detail:
              "The thread previously attached to this session is still shutting down. Retry in a moment.",
          });
        }
      }
    } else if (input.fork !== true) {
      return yield* new SessionImportError({
        reason: "already-imported",
        detail: `Session '${input.nativeSessionId}' is already attached to a t3 thread.`,
        existingThreadId: linkedThread.threadId,
      });
    }
    const validatedWorktree =
      input.worktree === undefined
        ? undefined
        : yield* validateWorktreeCwd(
            workspaceRoot,
            input.worktree.worktreePath,
            input.worktree.branch,
          );
    const effectiveCwd = validatedWorktree?.worktreePath ?? workspaceRoot;

    const threadUuid = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new SessionImportError({
            reason: "import-failed",
            detail: "Failed to generate an identifier for the imported thread.",
            cause,
          }),
      ),
    );
    const threadId = ThreadId.make(threadUuid);

    const history = yield* readImportable({
      nativeSessionId: input.nativeSessionId,
      cwd: effectiveCwd,
      destinationThreadId: threadId,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SessionImportError({
            reason: "provider-read-failed",
            detail: `Reading ${instance.driverKind} session '${input.nativeSessionId}' failed: ${
              typeof cause === "object" && cause !== null && "detail" in cause
                ? String((cause as { detail: unknown }).detail)
                : String(cause)
            }`,
            cause,
          }),
      ),
    );
    if (history.messages.length === 0) {
      return yield* new SessionImportError({
        reason: "nothing-to-import",
        detail: `Session '${input.nativeSessionId}' contains no importable messages.`,
      });
    }
    const warnings: Array<SessionImportWarning> = [];
    // The cap bounds imported *display* history only: the provider keeps the full
    // transcript, and the resume cursor binds to it, so a long session stays
    // continuable instead of being rejected outright.
    const importedMessages =
      history.messages.length > THREAD_IMPORT_MAX_MESSAGES
        ? history.messages.slice(history.messages.length - THREAD_IMPORT_MAX_MESSAGES)
        : history.messages;
    if (importedMessages.length !== history.messages.length) {
      const message = `Imported the most recent ${THREAD_IMPORT_MAX_MESSAGES} of ${history.messages.length} messages; the provider session retains the full history.`;
      warnings.push({ code: "history-truncated", message });
      yield* Effect.logWarning(message, {
        nativeSessionId: input.nativeSessionId,
        messageCount: history.messages.length,
      });
    }

    const modelSelection = yield* resolveModelSelection({
      instance,
      importedModel: history.model,
      ...(input.modelSelection === undefined ? {} : { override: input.modelSelection }),
    });
    const currentInstance = yield* instanceRegistry.getInstance(input.instanceId);
    if (currentInstance !== instance || !currentInstance.enabled) {
      return yield* new SessionImportError({
        reason: "instance-not-found",
        detail: `Provider instance '${input.instanceId}' changed while the session was being read. Retry the import with the current provider configuration.`,
      });
    }

    let resumeCursor = history.resumeCursor;
    let continuedNativeSessionId = input.nativeSessionId;
    let forkedNativeSessionId: string | undefined;
    let defaultTitle = titleForImport(history.name, importedMessages);
    if (linkedThread !== undefined && existingThreadId !== undefined) {
      const sourceThread = linkedThread;
      const forkSession = instance.adapter.forkSession;
      if (forkSession === undefined) {
        return yield* new SessionImportError({
          reason: "fork-unsupported",
          detail: `Provider instance '${input.instanceId}' does not support forking imported sessions.`,
          existingThreadId,
        });
      }
      const sessions = yield* instance.adapter.listSessions();
      const sourceSession = sessions.find((session) => session.threadId === existingThreadId);
      if (sourceSession !== undefined && sourceSession.status !== "ready") {
        // Matches ProviderService's fork guard: any non-ready state (running,
        // connecting, error, closed) means the source session cannot be
        // snapshotted safely right now.
        return yield* new SessionImportError({
          reason: "import-failed",
          detail: `Cannot import this session as a fork while thread '${sourceThread.title}''s provider session is ${sourceSession.status}.`,
        });
      }
      // ProviderService's thread lock is internal to that layer, so a small
      // readiness TOCTOU window remains; the fork input cursor is pinned by the
      // provider history read above.
      const forked = yield* forkSession({
        sourceThreadId: existingThreadId,
        destinationThreadId: threadId,
        sourceResumeCursor: history.resumeCursor,
        cwd: effectiveCwd,
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SessionImportError({
              reason: "import-failed",
              detail: `Failed to fork ${instance.driverKind} session '${input.nativeSessionId}' for import.`,
              cause,
            }),
        ),
      );
      resumeCursor = forked.resumeCursor;
      continuedNativeSessionId =
        nativeIdsFromCursor(forked.resumeCursor).find((id) => id !== threadId) ??
        input.nativeSessionId;
      forkedNativeSessionId = continuedNativeSessionId;
      defaultTitle = formatForkedThreadTitle(sourceThread.title);

      const currentInstanceAfterFork = yield* instanceRegistry.getInstance(input.instanceId);
      if (currentInstanceAfterFork !== instance || !currentInstanceAfterFork.enabled) {
        yield* Effect.logWarning(
          "Provider instance changed after forking an imported session; the native fork may have been left orphaned.",
          {
            instanceId: input.instanceId,
            forkedNativeSessionId,
          },
        );
        return yield* new SessionImportError({
          reason: "import-failed",
          detail: `Provider instance '${input.instanceId}' changed while the session was being forked. Retry the import with the current provider configuration.`,
        });
      }
    }

    const messages: ReadonlyArray<ThreadImportMessage> = importedMessages.map((message, index) => ({
      messageId: importMessageId(threadId, index),
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
    }));
    const createdAt = yield* nowIso;

    // Keep binding persistence, accepted dispatch, and failure compensation in
    // one critical section. Caller interruption must not leave either a visible
    // thread without its binding or a binding-only orphan.
    yield* Effect.gen(function* () {
      // Binding first: a failed dispatch never leaves a visible thread without
      // continuation, and the binding is compensated below.
      yield* sessionDirectory
        .upsert({
          threadId,
          provider: instance.driverKind,
          providerInstanceId: instance.instanceId,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          status: "stopped",
          resumeCursor,
          runtimePayload: {
            cwd: effectiveCwd,
            modelSelection,
            activeTurnId: null,
            continuationKey: instance.continuationIdentity.continuationKey,
            ...(validatedWorktree === undefined ? {} : { cwdAuthority: "imported-session" }),
            lastRuntimeEvent: "provider.importConversation",
            lastRuntimeEventAt: createdAt,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SessionImportError({
                reason: "import-failed",
                detail: "Failed to persist the provider binding for the imported session.",
                cause,
              }),
          ),
        );

      const dispatchResult = yield* orchestrationEngine
        .dispatch({
          type: "thread.import",
          // A compensated failed import must be retryable even when the
          // orchestration engine persisted a rejected command receipt.
          commandId: CommandId.make(`import:${threadId}`),
          threadId,
          projectId: input.projectId,
          title: input.title?.trim() || defaultTitle,
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          source: {
            provider: instance.driverKind,
            nativeSessionId: continuedNativeSessionId,
            nativeCwd: history.nativeCwd,
          },
          messages,
          createdAt,
        })
        // `exit` (not `result`) so defects also trigger binding compensation.
        .pipe(Effect.exit);

      if (Exit.isFailure(dispatchResult)) {
        if (forkedNativeSessionId !== undefined) {
          // The adapter contract has no fork cleanup operation, so the native
          // fork created above stays behind as an inert provider session.
          yield* Effect.logWarning(
            "Import dispatch failed after forking; the native fork is orphaned.",
            {
              threadId,
              orphanedForkedNativeSessionId: forkedNativeSessionId,
            },
          );
        }
        // Compensation: remove the binding so the import remains retryable.
        yield* runtimeRepository.deleteByThreadId({ threadId }).pipe(
          Effect.catch((cause) =>
            Effect.logError("Failed to compensate the import provider binding.", {
              threadId,
              cause,
            }),
          ),
        );
        return yield* new SessionImportError({
          reason: "import-failed",
          detail: `Importing session '${input.nativeSessionId}' failed while persisting the thread.`,
          cause: dispatchResult.cause,
        });
      }
    }).pipe(Effect.uninterruptible);

    if (validatedWorktree !== undefined) {
      const metaResult = yield* orchestrationEngine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`import-meta:${threadId}`),
          threadId,
          branch: validatedWorktree.branch,
          worktreePath: validatedWorktree.worktreePath,
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(metaResult)) {
        const message = `Imported thread ${threadId}, but failed to attach worktree metadata.`;
        warnings.push({ code: "meta-update-failed", message });
        yield* Effect.logWarning(message, {
          threadId,
          branch: validatedWorktree.branch,
          worktreePath: validatedWorktree.worktreePath,
          cause: metaResult.cause,
        });
      } else {
        // Once canonical worktree metadata is attached, normal thread metadata
        // can drive later intentional worktree changes. The durable binding
        // authority is retained only for the accepted warning-only failure path.
        const binding = Option.getOrUndefined(
          yield* sessionDirectory.getBinding(threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to inspect imported CWD authority.", {
                threadId,
                cause,
              }).pipe(Effect.as(Option.none())),
            ),
          ),
        );
        if (binding !== undefined) {
          yield* sessionDirectory
            .refreshIfUnchanged({
              binding,
              runtimePayloadPatch: { cwdAuthority: null },
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to release imported CWD authority.", {
                  threadId,
                  cause,
                }),
              ),
            );
        }
      }
    }

    return {
      threadId,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  });

  // The provider-runtime table is keyed by destination thread id, so checking
  // whether a native session is already bound cannot be made atomic there.
  // Serialize this rare operation to keep duplicate RPCs from creating two
  // bindings (or sharing one orchestration command receipt).
  const importSession: SessionImportServiceShape["importSession"] = (input) =>
    importSemaphore.withPermits(1)(importSessionUnlocked(input));

  return {
    listCandidates,
    importSession,
  } satisfies SessionImportServiceShape;
});

export const SessionImportServiceLive =
  Layer.effect(SessionImportService)(makeSessionImportService);
