// @effect-diagnostics nodeBuiltinImport:off - pure cross-platform CLI path derivation has no Effect context.
import * as NodePath from "node:path";

import {
  EnvironmentHttpApi,
  EnvironmentSessionImportError,
  type ModelSelection,
  type OrchestrationShellSnapshot,
  type ProviderCatalogInstance,
  type ProviderCatalogResult,
  type SessionImportListCandidatesPayload,
  type SessionImportPayload,
} from "@t3tools/contracts";
import { validateProviderOptionSelectionsStrict } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { sanitizeGitRepositoryEnvironment } from "../git/Utils.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  claudeProjectDirectoryName,
  parseClaudeTranscript,
} from "../provider/Drivers/ClaudeSessionImport.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { withCliJsonErrorOutput } from "./errorOutput.ts";
import {
  type CliLiveOrchestrationServer,
  type CliLiveServerReadTimeouts,
  CliOrchestrationServerUnavailableError,
  cliOrchestrationErrorFromRequest,
  dispatchLiveOrchestrationCommand,
  fetchLiveEnvironmentDescriptor,
  fetchLiveOrchestrationShell,
  resolveCliLiveServerReadTimeouts,
  withResolvedLiveOrchestrationServer,
} from "./orchestration.ts";
import { addProjectToOrchestration } from "./project.ts";
import {
  findActiveProjectTarget,
  normalizeWorkspaceRootForProjectCommand,
  ProjectNotFoundError,
} from "./projectTarget.ts";

const MAX_SESSION_FILE_BYTES = 256 * 1024 * 1024;
const SESSION_HTTP_READ_TIMEOUT = Duration.seconds(5);
const SESSION_HTTP_IMPORT_TIMEOUT = Duration.seconds(30);
const SESSION_GIT_TIMEOUT = Duration.seconds(30);
const SESSION_GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const jsonOutput = (value: unknown) => JSON.stringify(value, null, 2);
const isProjectNotFoundError = Schema.is(ProjectNotFoundError);
const isEnvironmentSessionImportError = Schema.is(EnvironmentSessionImportError);

export class SessionCliError extends Schema.TaggedErrorClass<SessionCliError>()("SessionCliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export class SessionCliServerUnsupportedError extends Schema.TaggedErrorClass<SessionCliServerUnsupportedError>()(
  "SessionCliServerUnsupportedError",
  {
    serverVersion: Schema.String,
    capability: Schema.Literals(["sessionImport", "providerCatalog", "turnStartBootstrap"]),
  },
) {
  override get message(): string {
    const capabilityLabel =
      this.capability === "sessionImport"
        ? "session import"
        : this.capability === "providerCatalog"
          ? "the provider catalog"
          : "creating threads in a new worktree";
    return `The running T3 Code server (${this.serverVersion}) does not support ${capabilityLabel}. Update and restart T3 Code, then retry.`;
  }
}
const isSessionCliError = Schema.is(SessionCliError);

interface SniffedSessionBase {
  readonly nativeSessionId: string;
  readonly sourceCwd: string;
  readonly lastSeenModel: string | null;
  readonly originalFileName: string;
}

export type SniffedSession =
  | (SniffedSessionBase & {
      readonly provider: "codex";
      readonly timestamp: string;
      readonly datePath: {
        readonly year: string;
        readonly month: string;
        readonly day: string;
      };
    })
  | (SniffedSessionBase & {
      readonly provider: "claudeAgent";
      readonly timestamp: null;
    });

interface CodexDatePath {
  readonly year: string;
  readonly month: string;
  readonly day: string;
}

function parseCodexDatePath(timestamp: string): CodexDatePath | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(timestamp);
  if (match === null || Number.isNaN(Date.parse(timestamp))) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth) return null;
  return { year: match[1]!, month: match[2]!, day: match[3]! };
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isJsonRecord(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function modelFromRecord(record: JsonRecord): string | null {
  return (
    nonEmptyString(record.model) ??
    nonEmptyString(record.model_slug) ??
    nonEmptyString(nestedRecord(record, "payload")?.model) ??
    nonEmptyString(nestedRecord(record, "payload")?.model_slug) ??
    nonEmptyString(nestedRecord(record, "message")?.model)
  );
}

const parseJsonLines = Effect.fn("parseJsonLines")(function* (content: string) {
  const records: Array<JsonRecord> = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    const value: unknown = yield* Effect.try({
      // @effect-diagnostics-next-line preferSchemaOverJson:off - provider JSONL is sniffed before its format-specific schema is known.
      try: () => JSON.parse(line),
      catch: (cause) =>
        new SessionCliError({
          operation: "sniffSession",
          detail: `Session transcript line ${index + 1} is not valid JSON.`,
          cause,
        }),
    });
    if (!isJsonRecord(value)) {
      return yield* new SessionCliError({
        operation: "sniffSession",
        detail: `Session transcript line ${index + 1} is not a JSON object.`,
      });
    }
    records.push(value);
  }
  return records;
});

export const sniffSessionTranscript = Effect.fn("sniffSessionTranscript")(function* (input: {
  readonly fileName: string;
  readonly content: string;
}) {
  if (new TextEncoder().encode(input.content).byteLength > MAX_SESSION_FILE_BYTES) {
    return yield* new SessionCliError({
      operation: "sniffSession",
      detail: `Session transcript exceeds the ${MAX_SESSION_FILE_BYTES} byte import limit.`,
    });
  }
  const records = yield* parseJsonLines(input.content);
  if (records.length === 0) {
    return yield* new SessionCliError({
      operation: "sniffSession",
      detail: "Session transcript is empty.",
    });
  }

  const first = records[0]!;
  if (first.type === "session_meta") {
    const payload = nestedRecord(first, "payload");
    const nativeSessionId = nonEmptyString(payload?.id);
    const sourceCwd = nonEmptyString(payload?.cwd);
    const timestamp = nonEmptyString(first.timestamp) ?? nonEmptyString(payload?.timestamp);
    if (nativeSessionId === null || sourceCwd === null || timestamp === null) {
      return yield* new SessionCliError({
        operation: "sniffSession",
        detail: "Codex session metadata must include payload.id, payload.cwd, and a timestamp.",
      });
    }
    const originalFileName = NodePath.basename(input.fileName);
    if (
      !UUID_PATTERN.test(nativeSessionId) ||
      !originalFileName.startsWith("rollout-") ||
      !originalFileName.endsWith(`-${nativeSessionId}.jsonl`)
    ) {
      return yield* new SessionCliError({
        operation: "sniffSession",
        detail:
          "Codex transcripts require a UUID session id matching the canonical rollout filename.",
      });
    }
    const datePath = parseCodexDatePath(timestamp);
    if (datePath === null) {
      return yield* new SessionCliError({
        operation: "sniffSession",
        detail: `Codex session timestamp '${timestamp}' must start with a valid ISO calendar date.`,
      });
    }
    let lastSeenModel: string | null = null;
    for (const record of records) {
      lastSeenModel = modelFromRecord(record) ?? lastSeenModel;
    }
    return {
      provider: "codex" as const,
      nativeSessionId,
      sourceCwd,
      lastSeenModel,
      timestamp,
      datePath,
      originalFileName,
    };
  }

  const typedRecords = records.filter((record) => nonEmptyString(record.type) !== null);
  const sessionIds = records
    .map((record) => nonEmptyString(record.sessionId))
    .filter((value): value is string => value !== null);
  const nativeSessionId = sessionIds[0] ?? null;
  // The records carry the session identity, so a transferred transcript imports
  // even when its filename was changed in transit; placement always uses the
  // record-derived id.
  if (
    typedRecords.length !== records.length ||
    nativeSessionId === null ||
    !UUID_PATTERN.test(nativeSessionId) ||
    sessionIds.some((sessionId) => sessionId !== nativeSessionId)
  ) {
    return yield* new SessionCliError({
      operation: "sniffSession",
      detail:
        "Unknown session format. Claude transcripts require typed JSONL records sharing one UUID sessionId.",
    });
  }
  let sourceCwd: string | null = null;
  let lastSeenModel: string | null = null;
  for (const record of records) {
    sourceCwd = nonEmptyString(record.cwd) ?? sourceCwd;
    lastSeenModel = modelFromRecord(record) ?? lastSeenModel;
  }
  if (sourceCwd === null) {
    return yield* new SessionCliError({
      operation: "sniffSession",
      detail: "Claude session transcript does not contain a source cwd.",
    });
  }
  const parsedTranscript = yield* parseClaudeTranscript({
    sessionId: nativeSessionId,
    lines: input.content.split(/\r?\n/),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SessionCliError({
          operation: "sniffSession",
          detail: `Claude session '${nativeSessionId}' line ${cause.line}: ${cause.detail}`,
          cause,
        }),
    ),
  );
  return {
    provider: "claudeAgent" as const,
    nativeSessionId,
    sourceCwd,
    lastSeenModel: parsedTranscript.model ?? lastSeenModel,
    timestamp: null,
    originalFileName: NodePath.basename(input.fileName),
  };
});

export function formatProviderInstanceLabel(displayName: string, instanceId: string): string {
  return `${displayName} [${instanceId}]`;
}

export const resolveImportInstance = Effect.fn("resolveImportInstance")(function* (input: {
  readonly catalog: ProviderCatalogResult;
  readonly provider: SniffedSession["provider"];
  readonly explicitInstanceId?: string;
}) {
  const eligible = input.catalog.instances.filter(
    (instance) =>
      instance.enabled && instance.importCapable && instance.driverKind === input.provider,
  );
  if (input.explicitInstanceId !== undefined) {
    const instance = input.catalog.instances.find(
      (candidate) => candidate.instanceId === input.explicitInstanceId,
    );
    if (
      instance === undefined ||
      !instance.enabled ||
      !instance.importCapable ||
      instance.driverKind !== input.provider
    ) {
      return yield* new SessionCliError({
        operation: "resolveImportInstance",
        detail: `Provider instance '${input.explicitInstanceId}' is not an enabled ${input.provider} session-import instance.`,
      });
    }
    return instance;
  }
  if (eligible.length === 1) return eligible[0]!;
  if (eligible.length === 0) {
    return yield* new SessionCliError({
      operation: "resolveImportInstance",
      detail: `No enabled ${input.provider} provider instance supports session import.`,
    });
  }
  return yield* new SessionCliError({
    operation: "resolveImportInstance",
    detail: `Multiple ${input.provider} provider instances support session import (${eligible.map((instance) => formatProviderInstanceLabel(instance.displayName, instance.instanceId)).join(", ")}). Pass --instance.`,
  });
});

export const deriveSessionWorktreePath = (input: {
  readonly baseDir: string;
  readonly workspaceRoot: string;
  readonly branch: string;
}): string =>
  NodePath.join(
    input.baseDir,
    "worktrees",
    NodePath.basename(input.workspaceRoot),
    input.branch.replace(/\//g, "-"),
  );

export const deriveSessionDestination = (input: {
  readonly session: SniffedSession;
  readonly instanceHome: string;
  readonly effectiveCwd: string;
}): string => {
  if (input.session.provider === "claudeAgent") {
    return NodePath.join(
      input.instanceHome,
      "projects",
      claudeProjectDirectoryName(input.effectiveCwd),
      `${input.session.nativeSessionId}.jsonl`,
    );
  }
  return NodePath.join(
    input.instanceHome,
    "sessions",
    input.session.datePath.year,
    input.session.datePath.month,
    input.session.datePath.day,
    input.session.originalFileName,
  );
};

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function decideSessionPlacement(
  source: Uint8Array,
  existing: Uint8Array | null,
): "write" | "skip-identical" | "error-different" {
  if (existing === null) return "write";
  return bytesEqual(source, existing) ? "skip-identical" : "error-different";
}

/**
 * Retargets the `cwd` recorded in a Codex rollout to the workspace it is being
 * imported into. Codex validates a thread's recorded cwd against the selected
 * workspace (`CodexAdapter.readImportableSession`), so a rollout moved between
 * machines — or into a differently-named worktree — is rejected until its own
 * metadata agrees with where it now lives. Lines without the old path, and
 * mentions of it inside message text, are left byte-identical.
 */
export const rewriteCodexTranscriptCwd = (input: {
  readonly content: string;
  readonly from: string;
  readonly to: string;
}): { readonly content: string; readonly rewritten: number } => {
  if (input.from === input.to) return { content: input.content, rewritten: 0 };
  let rewritten = 0;
  const retarget = (value: unknown): boolean => {
    let changed = false;
    if (Array.isArray(value)) {
      for (const item of value) changed = retarget(item) || changed;
      return changed;
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const [key, nested] of Object.entries(record)) {
        if (key === "cwd" && nested === input.from) {
          record[key] = input.to;
          rewritten += 1;
          changed = true;
          continue;
        }
        changed = retarget(nested) || changed;
      }
    }
    return changed;
  };
  const content = input.content
    .split("\n")
    .map((line) => {
      if (!line.includes(input.from)) return line;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return line;
      }
      // Only rewritten lines are re-serialised; every other line passes through untouched.
      return retarget(parsed) ? JSON.stringify(parsed) : line;
    })
    .join("\n");
  return { content, rewritten };
};

export const placeSessionFile = Effect.fn("placeSessionFile")(function* (input: {
  readonly destinationPath: string;
  readonly bytes: Uint8Array;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destinationExists = yield* fileSystem.exists(input.destinationPath).pipe(
    Effect.mapError(
      (cause) =>
        new SessionCliError({
          operation: "placeSessionFile",
          detail: `Failed to inspect destination '${input.destinationPath}'.`,
          cause,
        }),
    ),
  );
  if (destinationExists) {
    const existing = yield* fileSystem.readFile(input.destinationPath).pipe(
      Effect.mapError(
        (cause) =>
          new SessionCliError({
            operation: "placeSessionFile",
            detail: `Failed to read existing destination '${input.destinationPath}'.`,
            cause,
          }),
      ),
    );
    if (decideSessionPlacement(input.bytes, existing) === "skip-identical") {
      return { path: input.destinationPath, action: "skipped-identical" as const };
    }
    return yield* new SessionCliError({
      operation: "placeSessionFile",
      detail: `Destination '${input.destinationPath}' already exists with different content.`,
    });
  }

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = path.dirname(input.destinationPath);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const tempPath = yield* fileSystem.makeTempFileScoped({
        directory,
        prefix: `.${path.basename(input.destinationPath)}.`,
        suffix: ".tmp",
      });
      const handle = yield* fileSystem.open(tempPath, { flag: "w" });
      yield* handle.writeAll(input.bytes);
      yield* handle.sync;
      const linked = yield* fileSystem.link(tempPath, input.destinationPath).pipe(Effect.result);
      if (linked._tag === "Success") {
        return { path: input.destinationPath, action: "placed" as const };
      }
      const existing = yield* fileSystem.readFile(input.destinationPath).pipe(
        Effect.mapError(
          (_cause) =>
            new SessionCliError({
              operation: "placeSessionFile",
              detail: `Atomic placement of '${input.destinationPath}' failed.`,
              cause: linked.failure,
            }),
        ),
      );
      if (decideSessionPlacement(input.bytes, existing) === "skip-identical") {
        return { path: input.destinationPath, action: "skipped-identical" as const };
      }
      return yield* new SessionCliError({
        operation: "placeSessionFile",
        detail: `Destination '${input.destinationPath}' appeared with different content during placement.`,
        cause: linked.failure,
      });
    }).pipe(
      Effect.mapError((cause) =>
        isSessionCliError(cause)
          ? cause
          : new SessionCliError({
              operation: "placeSessionFile",
              detail: `Failed to place session transcript at '${input.destinationPath}'.`,
              cause,
            }),
      ),
    ),
  );
});

export const resolveCliModelSelection = Effect.fn("resolveCliModelSelection")(function* (input: {
  readonly instance: ProviderCatalogInstance;
  readonly explicitModel?: string;
  readonly sniffedModel?: string | null;
  readonly effort?: string;
}) {
  const concreteModel =
    input.explicitModel ??
    (input.sniffedModel !== null &&
    input.sniffedModel !== undefined &&
    input.instance.models.some((model) => model.slug === input.sniffedModel)
      ? input.sniffedModel
      : undefined);
  if (input.explicitModel !== undefined && concreteModel !== undefined) {
    if (!input.instance.models.some((model) => model.slug === concreteModel)) {
      return yield* new SessionCliError({
        operation: "resolveModelSelection",
        detail: `Model '${concreteModel}' is not advertised by provider instance '${input.instance.instanceId}'.`,
      });
    }
  }
  if (input.effort !== undefined && concreteModel === undefined) {
    return yield* new SessionCliError({
      operation: "resolveModelSelection",
      detail:
        "--effort requires a concrete --model (or an advertised model in the imported transcript).",
    });
  }
  if (concreteModel === undefined) return undefined;
  const model = input.instance.models.find((candidate) => candidate.slug === concreteModel)!;
  const options =
    input.effort === undefined
      ? undefined
      : [
          {
            id: input.instance.driverKind === "codex" ? "reasoningEffort" : "effort",
            value: input.effort,
          },
        ];
  const validation = validateProviderOptionSelectionsStrict({
    descriptors: model.optionDescriptors,
    selections: options ?? [],
  });
  if (validation !== null) {
    return yield* new SessionCliError({
      operation: "resolveModelSelection",
      detail: validation.detail,
    });
  }
  return {
    instanceId: input.instance.instanceId,
    model: concreteModel,
    ...(options === undefined ? {} : { options }),
  } satisfies ModelSelection;
});

export const resolveThreadModelInstance = Effect.fn("resolveThreadModelInstance")(
  function* (input: {
    readonly catalog: ProviderCatalogResult;
    readonly model: string;
    readonly explicitInstanceId?: string;
  }) {
    if (input.explicitInstanceId !== undefined) {
      const instance = input.catalog.instances.find(
        (candidate) =>
          candidate.instanceId === input.explicitInstanceId &&
          candidate.enabled &&
          candidate.models.some((model) => model.slug === input.model),
      );
      if (instance !== undefined) return instance;
      return yield* new SessionCliError({
        operation: "resolveThreadModelInstance",
        detail: `Provider instance '${input.explicitInstanceId}' does not advertise model '${input.model}'.`,
      });
    }
    const matches = input.catalog.instances.filter(
      (instance) => instance.enabled && instance.models.some((model) => model.slug === input.model),
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      return yield* new SessionCliError({
        operation: "resolveThreadModelInstance",
        detail: `No enabled provider instance advertises model '${input.model}'.`,
      });
    }
    return yield* new SessionCliError({
      operation: "resolveThreadModelInstance",
      detail: `Multiple provider instances advertise model '${input.model}' (${matches.map((instance) => instance.instanceId).join(", ")}). Pass --instance.`,
    });
  },
);

const makeHttpClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });

function sessionTransportError(operation: string, cause: unknown) {
  return new SessionCliError({
    operation,
    detail: `The live T3 Code server did not complete ${operation} within the allowed time.`,
    cause,
  });
}

export function sessionHttpError(operation: string, cause: unknown) {
  if (isEnvironmentSessionImportError(cause)) return cause;
  return Cause.isTimeoutError(cause)
    ? sessionTransportError(operation, cause)
    : cliOrchestrationErrorFromRequest(cause);
}

export const fetchProviderCatalog = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const client = yield* makeHttpClient(origin);
    return yield* client.providers.catalog({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(
    Effect.timeout(SESSION_HTTP_READ_TIMEOUT),
    Effect.mapError((cause) => sessionHttpError("provider catalog", cause)),
  );

const fetchSessionCandidates = (
  origin: string,
  bearerToken: string,
  payload: SessionImportListCandidatesPayload,
) =>
  Effect.gen(function* () {
    const client = yield* makeHttpClient(origin);
    return yield* client.sessionImport.candidates({
      headers: { authorization: `Bearer ${bearerToken}` },
      payload,
    });
  }).pipe(
    Effect.timeout(SESSION_HTTP_READ_TIMEOUT),
    Effect.mapError((cause) => sessionHttpError("session candidate listing", cause)),
  );

const importSession = (origin: string, bearerToken: string, payload: SessionImportPayload) =>
  Effect.gen(function* () {
    const client = yield* makeHttpClient(origin);
    return yield* client.sessionImport.importSession({
      headers: { authorization: `Bearer ${bearerToken}` },
      payload,
    });
  }).pipe(
    Effect.timeout(SESSION_HTTP_IMPORT_TIMEOUT),
    Effect.mapError((cause) => sessionHttpError("session import", cause)),
  );

interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export const runGitCommand = Effect.fn("session.runGitCommand")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const processRunner = yield* ProcessRunner.make();
  const result = yield* processRunner
    .run({
      command: "git",
      args,
      cwd,
      env: {
        ...sanitizeGitRepositoryEnvironment(),
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: SESSION_GIT_TIMEOUT,
      maxOutputBytes: SESSION_GIT_MAX_OUTPUT_BYTES,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new SessionCliError({
            operation: "runGitCommand",
            detail: cause.message,
            cause,
          }),
      ),
    );
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exitCode: result.code === null ? -1 : Number(result.code),
  } satisfies GitCommandResult;
});

const resolveExistingGitWorkspaceRoot = Effect.fn("session.resolveExistingGitWorkspaceRoot")(
  function* (identifier: string) {
    const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(identifier).pipe(
      Effect.mapError(
        (cause) =>
          new SessionCliError({
            operation: "resolveProject",
            detail: `No active project or existing repository was found for '${identifier}'.`,
            cause,
          }),
      ),
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* fileSystem.stat(workspaceRoot).pipe(
      Effect.mapError(
        (cause) =>
          new SessionCliError({
            operation: "resolveProject",
            detail: `Project path '${workspaceRoot}' does not exist.`,
            cause,
          }),
      ),
    );
    if (info.type !== "Directory") {
      return yield* new SessionCliError({
        operation: "resolveProject",
        detail: `Project path '${workspaceRoot}' is not a directory.`,
      });
    }
    const gitCheck = yield* runGitCommand(workspaceRoot, [
      "rev-parse",
      "--is-inside-work-tree",
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new SessionCliError({
            operation: "resolveProject",
            detail: `Failed to inspect git repository '${workspaceRoot}'.`,
            cause,
          }),
      ),
    );
    if (gitCheck.exitCode !== 0 || gitCheck.stdout !== "true") {
      return yield* new SessionCliError({
        operation: "resolveProject",
        detail: `Path '${workspaceRoot}' is not an existing git repository.`,
      });
    }
    return workspaceRoot;
  },
);

const resolveOrAddProject = Effect.fn("resolveOrAddProject")(function* (input: {
  readonly origin: string;
  readonly bearerToken: string;
  readonly shell: OrchestrationShellSnapshot;
  readonly identifier: string;
  readonly timeouts: CliLiveServerReadTimeouts;
}) {
  const resolved = yield* findActiveProjectTarget({
    projects: input.shell.projects,
    identifier: input.identifier,
  }).pipe(Effect.result);
  if (resolved._tag === "Success") {
    return { project: resolved.success, shell: input.shell };
  }
  if (!isProjectNotFoundError(resolved.failure)) return yield* resolved.failure;

  const workspaceRoot = yield* resolveExistingGitWorkspaceRoot(input.identifier);
  const added = yield* addProjectToOrchestration({
    projects: input.shell.projects,
    workspaceRoot,
    dispatch: (command) =>
      dispatchLiveOrchestrationCommand(input.origin, input.bearerToken, command),
  });
  const shell = yield* fetchLiveOrchestrationShell(input.origin, input.bearerToken, input.timeouts);
  const project =
    shell.projects.find((candidate) => candidate.id === added.projectId) ??
    (yield* findActiveProjectTarget({
      projects: shell.projects,
      identifier: added.workspaceRoot,
    }));
  return { project, shell };
});

export const resolveGitCommonDirectory = Effect.fn("session.resolveGitCommonDirectory")(function* (
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const result = yield* runGitCommand(cwd, ["rev-parse", "--git-common-dir"]);
  if (result.exitCode !== 0 || result.stdout.length === 0) {
    return yield* new SessionCliError({
      operation: "validateWorktree",
      detail: `Failed to resolve the Git common directory for '${cwd}': ${result.stderr || "git rev-parse failed"}`,
    });
  }
  const resolved = path.isAbsolute(result.stdout)
    ? result.stdout
    : path.resolve(cwd, result.stdout);
  return yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
});

export const ensureWorktree = Effect.fn("ensureWorktree")(function* (input: {
  readonly baseDir: string;
  readonly workspaceRoot: string;
  readonly branch: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const branch = input.branch.trim();
  if (branch.length === 0) {
    return yield* new SessionCliError({
      operation: "createWorktree",
      detail: "Worktree branch cannot be empty.",
    });
  }
  const branchCheck = yield* runGitCommand(input.workspaceRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (branchCheck.exitCode !== 0) {
    return yield* new SessionCliError({
      operation: "createWorktree",
      detail: `Local branch '${branch}' does not exist. Fetch/push the branch first; the session CLI never fetches.`,
    });
  }
  const worktreePath = deriveSessionWorktreePath({
    baseDir: input.baseDir,
    workspaceRoot: input.workspaceRoot,
    branch,
  });
  if (!(yield* fileSystem.exists(worktreePath))) {
    yield* fileSystem.makeDirectory(path.dirname(worktreePath), { recursive: true });
    const result = yield* runGitCommand(input.workspaceRoot, [
      "worktree",
      "add",
      worktreePath,
      branch,
    ]);
    if (result.exitCode !== 0) {
      return yield* new SessionCliError({
        operation: "createWorktree",
        detail: `Failed to create worktree '${worktreePath}' for branch '${branch}': ${result.stderr || "git worktree add failed"}`,
      });
    }
  }
  const canonicalPath = yield* fileSystem.realPath(worktreePath).pipe(
    Effect.mapError(
      (cause) =>
        new SessionCliError({
          operation: "createWorktree",
          detail: `Failed to canonicalize worktree '${worktreePath}'.`,
          cause,
        }),
    ),
  );
  const [projectGitDirectory, worktreeGitDirectory] = yield* Effect.all(
    [resolveGitCommonDirectory(input.workspaceRoot), resolveGitCommonDirectory(canonicalPath)],
    { concurrency: "unbounded" },
  );
  if (projectGitDirectory !== worktreeGitDirectory) {
    return yield* new SessionCliError({
      operation: "createWorktree",
      detail: `Existing worktree path '${canonicalPath}' belongs to a different Git repository.`,
    });
  }
  const currentBranch = yield* runGitCommand(canonicalPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (currentBranch.exitCode !== 0) {
    return yield* new SessionCliError({
      operation: "createWorktree",
      detail: `Existing worktree path '${canonicalPath}' has a detached HEAD.`,
    });
  }
  if (currentBranch.stdout !== branch) {
    return yield* new SessionCliError({
      operation: "createWorktree",
      detail: `Existing worktree path '${canonicalPath}' is on branch '${currentBranch.stdout}', not '${branch}'.`,
    });
  }
  return { branch, worktreePath: canonicalPath };
});

const runSessionCli = Effect.fn("runSessionCli")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  json: boolean,
  capabilities: ReadonlyArray<"sessionImport" | "providerCatalog">,
  run: (input: {
    readonly live: CliLiveOrchestrationServer;
    readonly config: ServerConfig.ServerConfig["Service"];
    readonly token: string;
    readonly timeouts: CliLiveServerReadTimeouts;
  }) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  return yield* Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = json ? "None" : config.logLevel;
    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const timeouts = yield* resolveCliLiveServerReadTimeouts(flags.timeoutMs ?? Option.none());
      const outcome = yield* withResolvedLiveOrchestrationServer(
        { environmentAuth, config, label: "t3 session cli", timeouts },
        (live, token) =>
          Effect.gen(function* () {
            const descriptor = yield* fetchLiveEnvironmentDescriptor(live.origin, timeouts);
            for (const capability of capabilities) {
              if (descriptor.capabilities[capability] !== true) {
                return yield* new SessionCliServerUnsupportedError({
                  serverVersion: descriptor.serverVersion,
                  capability,
                });
              }
            }
            return yield* run({ live, config, token, timeouts });
          }),
      );
      if (Option.isNone(outcome)) {
        return yield* new CliOrchestrationServerUnavailableError({
          operation: "resolveLiveServer",
          statePath: config.serverRuntimeStatePath,
        });
      }
      return outcome.value;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(EnvironmentAuth.runtimeLayer, WorkspacePaths.layer).pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
      Effect.provideService(References.MinimumLogLevel, minimumLogLevel),
    );
  }).pipe(withCliJsonErrorOutput(json));
});

const sessionCandidatesCommand = Command.make("candidates", {
  ...projectLocationFlags,
  project: Flag.string("project").pipe(Flag.withDescription("Project id or workspace root.")),
  cwd: Flag.string("cwd").pipe(
    Flag.withDescription("Optional existing project worktree to inspect."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List importable provider sessions for a project."),
  Command.withHandler((flags) =>
    runSessionCli(flags, flags.json, ["sessionImport"], ({ live, token }) =>
      Effect.gen(function* () {
        const project = yield* findActiveProjectTarget({
          projects: live.shell.projects,
          identifier: flags.project,
        });
        const result = yield* fetchSessionCandidates(live.origin, token, {
          projectId: project.id,
          ...(Option.isSome(flags.cwd) ? { cwd: flags.cwd.value } : {}),
        });
        yield* Console.log(
          flags.json
            ? jsonOutput({ projectId: project.id, candidates: result.candidates })
            : result.candidates.length === 0
              ? "No importable sessions."
              : result.candidates
                  .map(
                    (candidate) =>
                      `${candidate.nativeSessionId}\t${formatProviderInstanceLabel(candidate.providerDisplayName, candidate.instanceId)}\t${candidate.updatedAt}\t${candidate.preview}`,
                  )
                  .join("\n"),
        );
      }),
    ),
  ),
);

const sessionImportCommand = Command.make("import", {
  ...projectLocationFlags,
  file: Flag.string("file").pipe(Flag.withDescription("Provider JSONL session transcript.")),
  project: Flag.string("project").pipe(
    Flag.withDescription("Project id, workspace root, or existing git repo path to auto-add."),
  ),
  worktreeBranch: Flag.string("worktree-branch").pipe(
    Flag.withDescription(
      "Use/create the standard worktree for this local branch. Setup scripts and git-status refresh are not run.",
    ),
    Flag.optional,
  ),
  model: Flag.string("model").pipe(
    Flag.withDescription("Explicit imported thread model."),
    Flag.optional,
  ),
  effort: Flag.string("effort").pipe(
    Flag.withDescription("Provider effort/reasoning-effort option."),
    Flag.optional,
  ),
  instance: Flag.string("instance").pipe(
    Flag.withDescription("Explicit provider instance id."),
    Flag.optional,
  ),
  title: Flag.string("title").pipe(
    Flag.withDescription("Thread title; defaults to the provider session name."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Place and import a Claude or Codex CLI session transcript."),
  Command.withHandler((flags) =>
    runSessionCli(
      flags,
      flags.json,
      ["sessionImport", "providerCatalog"],
      ({ live, config, token, timeouts }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const sourceInfo = yield* fileSystem.stat(flags.file).pipe(
            Effect.mapError(
              (cause) =>
                new SessionCliError({
                  operation: "readSessionFile",
                  detail: `Failed to stat session transcript '${flags.file}'.`,
                  cause,
                }),
            ),
          );
          if (sourceInfo.type !== "File") {
            return yield* new SessionCliError({
              operation: "readSessionFile",
              detail: `Session transcript '${flags.file}' is not a file.`,
            });
          }
          if (sourceInfo.size > MAX_SESSION_FILE_BYTES) {
            return yield* new SessionCliError({
              operation: "readSessionFile",
              detail: `Session transcript exceeds the ${MAX_SESSION_FILE_BYTES} byte import limit.`,
            });
          }
          const sourceBytes = yield* fileSystem.readFile(flags.file);
          const session = yield* sniffSessionTranscript({
            fileName: flags.file,
            content: new TextDecoder().decode(sourceBytes),
          });
          const catalog = yield* fetchProviderCatalog(live.origin, token);
          const instance = yield* resolveImportInstance({
            catalog,
            provider: session.provider,
            ...(Option.isSome(flags.instance) ? { explicitInstanceId: flags.instance.value } : {}),
          });
          if (instance.home === undefined) {
            return yield* new SessionCliError({
              operation: "resolveImportInstance",
              detail: `Provider instance '${instance.instanceId}' did not advertise an import home.`,
            });
          }
          const modelSelection = yield* resolveCliModelSelection({
            instance,
            ...(Option.isSome(flags.model) ? { explicitModel: flags.model.value } : {}),
            sniffedModel: session.lastSeenModel,
            ...(Option.isSome(flags.effort) ? { effort: flags.effort.value } : {}),
          });
          const existingProject = yield* findActiveProjectTarget({
            projects: live.shell.projects,
            identifier: flags.project,
          }).pipe(Effect.result);
          if (
            existingProject._tag === "Failure" &&
            !isProjectNotFoundError(existingProject.failure)
          ) {
            return yield* existingProject.failure;
          }
          const preAddWorktree =
            Option.isSome(flags.worktreeBranch) && existingProject._tag === "Failure"
              ? yield* ensureWorktree({
                  baseDir: config.baseDir,
                  workspaceRoot: yield* resolveExistingGitWorkspaceRoot(flags.project),
                  branch: flags.worktreeBranch.value,
                })
              : undefined;
          const { project } = yield* resolveOrAddProject({
            origin: live.origin,
            bearerToken: token,
            shell: live.shell,
            identifier: flags.project,
            timeouts,
          });
          const worktree = Option.isSome(flags.worktreeBranch)
            ? (preAddWorktree ??
              (yield* ensureWorktree({
                baseDir: config.baseDir,
                workspaceRoot: project.workspaceRoot,
                branch: flags.worktreeBranch.value,
              })))
            : undefined;
          const effectiveCwd =
            worktree?.worktreePath ??
            (yield* fileSystem
              .realPath(project.workspaceRoot)
              .pipe(Effect.orElseSucceed(() => project.workspaceRoot)));
          const placedPath = deriveSessionDestination({
            session,
            instanceHome: instance.home,
            effectiveCwd,
          });
          // Codex validates a thread's recorded cwd against the workspace it is
          // imported into, so a transferred rollout is retargeted before placement.
          const retargeted =
            session.provider === "codex"
              ? rewriteCodexTranscriptCwd({
                  content: new TextDecoder().decode(sourceBytes),
                  from: session.sourceCwd,
                  to: effectiveCwd,
                })
              : { content: null, rewritten: 0 };
          const placedBytes =
            retargeted.content === null || retargeted.rewritten === 0
              ? sourceBytes
              : new TextEncoder().encode(retargeted.content);
          yield* placeSessionFile({ destinationPath: placedPath, bytes: placedBytes });
          const result = yield* importSession(live.origin, token, {
            projectId: project.id,
            instanceId: instance.instanceId,
            nativeSessionId: session.nativeSessionId,
            ...(Option.isSome(flags.title) ? { title: flags.title.value } : {}),
            ...(modelSelection === undefined ? {} : { modelSelection }),
            ...(worktree === undefined ? {} : { worktree }),
          }).pipe(Effect.result);
          if (result._tag === "Failure") {
            const error = result.failure;
            if (
              isEnvironmentSessionImportError(error) &&
              error.reason === "already-imported" &&
              error.existingThreadId !== undefined
            ) {
              yield* Console.log(
                flags.json
                  ? jsonOutput({
                      threadId: error.existingThreadId,
                      action: "already-imported",
                    })
                  : `Session is already imported as thread ${error.existingThreadId}.`,
              );
              return;
            }
            if (isEnvironmentSessionImportError(error)) {
              return yield* new SessionCliError({
                operation: "importSession",
                detail: error.detail,
              });
            }
            return yield* error;
          }
          const output = {
            threadId: result.success.threadId,
            action: "imported" as const,
            projectId: project.id,
            instanceId: instance.instanceId,
            nativeSessionId: session.nativeSessionId,
            placedPath,
            ...(retargeted.rewritten === 0 ? {} : { retargetedCwdFields: retargeted.rewritten }),
            ...(worktree === undefined ? {} : { worktreePath: worktree.worktreePath }),
            ...(result.success.warnings === undefined ? {} : { warnings: result.success.warnings }),
          };
          yield* Console.log(
            flags.json
              ? jsonOutput(output)
              : [
                  `Imported session ${session.nativeSessionId} as thread ${result.success.threadId}.`,
                  ...(result.success.warnings ?? []).map(
                    (warning) => `Warning: ${warning.message}`,
                  ),
                ].join("\n"),
          );
        }),
    ),
  ),
);

export const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Inspect and import provider CLI sessions."),
  Command.withSubcommands([sessionCandidatesCommand, sessionImportCommand]),
);
