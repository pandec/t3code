/**
 * SessionImportService — imports Claude Code / Codex CLI sessions created
 * outside t3code as new t3 threads.
 *
 * Flow per import: read native history through the provider adapter, write
 * the provider binding FIRST (so a half-completed import hides the candidate
 * instead of leaving a visible non-continuable thread), then dispatch the
 * `thread.import` orchestration command. On dispatch failure the binding is
 * compensated (deleted) so the candidate reappears.
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
import { validateProviderOptionSelectionsStrict } from "@t3tools/shared/model";

import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { sanitizeGitRepositoryEnvironment } from "../git/Utils.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
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
  return normalizedTitle(firstUser ?? messages[0]?.text ?? "") ?? "Imported session";
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

  const listBoundNativeIdsByInstance = Effect.fn("listBoundNativeIdsByInstance")(function* (
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
    const idsByContinuationKey = new Map<string, Map<string, ThreadId>>();
    for (const binding of bindings) {
      // Legacy rows without an explicit instance id belong to the default
      // instance, whose id is the provider/driver name.
      const ownerInstanceId = binding.providerInstanceId ?? binding.providerName;
      const continuationKey =
        continuationKeyByInstance.get(ownerInstanceId) ?? `provider-instance:${ownerInstanceId}`;
      const ids = idsByContinuationKey.get(continuationKey) ?? new Map<string, ThreadId>();
      for (const id of nativeIdsFromCursor(binding.resumeCursor)) {
        if (!ids.has(id)) ids.set(id, binding.threadId);
      }
      if (ids.size > 0) {
        idsByContinuationKey.set(continuationKey, ids);
      }
    }
    const idsByInstance = new Map<string, Map<string, ThreadId>>();
    for (const instance of instances) {
      const continuationKey =
        instance.continuationIdentity?.continuationKey ??
        `provider-instance:${instance.instanceId}`;
      const ids = idsByContinuationKey.get(continuationKey);
      if (ids !== undefined) idsByInstance.set(instance.instanceId, ids);
    }
    return idsByInstance;
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
    const boundNativeIdsByInstance = yield* listBoundNativeIdsByInstance(instances);
    const effectiveCwd =
      input.cwd === undefined
        ? workspaceRoot
        : (yield* validateWorktreeCwd(workspaceRoot, input.cwd)).worktreePath;
    const candidates: Array<SessionImportCandidate> = [];
    for (const instance of instances) {
      if (!instance.enabled) continue;
      const listImportable = instance.adapter.listImportableSessions;
      if (listImportable === undefined) continue;
      const boundNativeIds = boundNativeIdsByInstance.get(instance.instanceId);
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
        if (boundNativeIds?.has(session.nativeSessionId) === true) continue;
        candidates.push({
          instanceId: instance.instanceId,
          provider: instance.driverKind,
          providerDisplayName: instance.displayName ?? instance.driverKind,
          nativeSessionId: session.nativeSessionId,
          name: session.name !== null ? session.name.slice(0, PREVIEW_MAX_CHARS) : null,
          preview: session.preview.slice(0, PREVIEW_MAX_CHARS),
          messageCount: session.messageCount,
          updatedAt: session.updatedAt,
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
    const boundNativeIdsByInstance = yield* listBoundNativeIdsByInstance(instances);
    const existingThreadId = boundNativeIdsByInstance
      .get(input.instanceId)
      ?.get(input.nativeSessionId);
    if (existingThreadId !== undefined) {
      return yield* new SessionImportError({
        reason: "already-imported",
        detail: `Session '${input.nativeSessionId}' is already attached to a t3 thread.`,
        existingThreadId,
      });
    }

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
      // Binding first: a failed dispatch leaves only a hidden candidate (safe,
      // compensated below), never a visible thread without continuation.
      yield* sessionDirectory
        .upsert({
          threadId,
          provider: instance.driverKind,
          providerInstanceId: instance.instanceId,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          status: "stopped",
          resumeCursor: history.resumeCursor,
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
          title: input.title?.trim() || titleForImport(history.name, importedMessages),
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          source: {
            provider: instance.driverKind,
            nativeSessionId: input.nativeSessionId,
            nativeCwd: history.nativeCwd,
          },
          messages,
          createdAt,
        })
        // `exit` (not `result`) so defects also trigger binding compensation.
        .pipe(Effect.exit);

      if (Exit.isFailure(dispatchResult)) {
        // Compensation: remove the binding so the candidate reappears.
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
