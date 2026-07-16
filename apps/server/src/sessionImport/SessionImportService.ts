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
  ThreadId,
  type ThreadImportMessage,
  THREAD_IMPORT_MAX_MESSAGES,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Semaphore from "effect/Semaphore";

import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";

export interface SessionImportResult {
  readonly threadId: ThreadId;
}

export interface SessionImportServiceShape {
  readonly listCandidates: (input: {
    readonly projectId: ProjectId;
  }) => Effect.Effect<ReadonlyArray<SessionImportCandidate>, SessionImportError>;
  readonly importSession: (input: {
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
    readonly nativeSessionId: string;
  }) => Effect.Effect<SessionImportResult, SessionImportError>;
}

export class SessionImportService extends Context.Service<
  SessionImportService,
  SessionImportServiceShape
>()("t3/sessionImport/SessionImportService") {}

const PREVIEW_MAX_CHARS = 120;
const TITLE_MAX_CHARS = 80;

function importMessageId(threadId: ThreadId, index: number) {
  return MessageId.make(`import:${threadId}:${String(index).padStart(5, "0")}`);
}

function titleFromMessages(messages: ReadonlyArray<{ role: string; text: string }>): string {
  const firstUser = messages.find((message) => message.role === "user")?.text;
  const seed = (firstUser ?? messages[0]?.text ?? "Imported session").trim();
  const singleLine = seed.split("\n")[0]?.trim() ?? "Imported session";
  const truncated = singleLine.slice(0, TITLE_MAX_CHARS).trim();
  return truncated.length > 0 ? truncated : "Imported session";
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

  const listBoundNativeIds = Effect.fn("listBoundNativeIds")(function* () {
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
    const ids = new Set<string>();
    for (const binding of bindings) {
      for (const id of nativeIdsFromCursor(binding.resumeCursor)) {
        ids.add(id);
      }
    }
    return ids;
  });

  const listCandidates: SessionImportServiceShape["listCandidates"] = Effect.fn(
    "SessionImportService.listCandidates",
  )(function* (input) {
    const { workspaceRoot } = yield* resolveProjectWorkspaceRoot(input.projectId);
    const boundNativeIds = yield* listBoundNativeIds();
    const instances = yield* instanceRegistry.listInstances;
    const candidates: Array<SessionImportCandidate> = [];
    for (const instance of instances) {
      if (!instance.enabled) continue;
      const listImportable = instance.adapter.listImportableSessions;
      if (listImportable === undefined) continue;
      const sessions = yield* listImportable({ cwd: workspaceRoot }).pipe(
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
        if (boundNativeIds.has(session.nativeSessionId)) continue;
        candidates.push({
          instanceId: instance.instanceId,
          provider: instance.driverKind,
          providerDisplayName: instance.displayName ?? instance.driverKind,
          nativeSessionId: session.nativeSessionId,
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
  }) {
    const snapshot = yield* input.instance.snapshot.getSnapshot;
    const knownSlugs = new Set(snapshot.models.map((model) => model.slug));
    const fallback =
      snapshot.models.find((model) => model.isCustom !== true)?.slug ??
      snapshot.models[0]?.slug ??
      DEFAULT_MODEL_BY_PROVIDER[input.instance.driverKind];
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
    const boundNativeIds = yield* listBoundNativeIds();
    if (boundNativeIds.has(input.nativeSessionId)) {
      return yield* new SessionImportError({
        reason: "already-imported",
        detail: `Session '${input.nativeSessionId}' is already attached to a t3 thread.`,
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
      cwd: workspaceRoot,
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
    if (history.messages.length > THREAD_IMPORT_MAX_MESSAGES) {
      return yield* new SessionImportError({
        reason: "import-failed",
        detail: `Session '${input.nativeSessionId}' has ${history.messages.length} messages, above the ${THREAD_IMPORT_MAX_MESSAGES} import limit.`,
      });
    }

    const modelSelection = yield* resolveModelSelection({
      instance,
      importedModel: history.model,
    });
    const currentInstance = yield* instanceRegistry.getInstance(input.instanceId);
    if (currentInstance !== instance || !currentInstance.enabled) {
      return yield* new SessionImportError({
        reason: "instance-not-found",
        detail: `Provider instance '${input.instanceId}' changed while the session was being read. Retry the import with the current provider configuration.`,
      });
    }
    const messages: ReadonlyArray<ThreadImportMessage> = history.messages.map((message, index) => ({
      messageId: importMessageId(threadId, index),
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
    }));
    const createdAt = yield* nowIso;

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
          cwd: workspaceRoot,
          modelSelection,
          activeTurnId: null,
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
        title: titleFromMessages(history.messages),
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

    return { threadId };
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
