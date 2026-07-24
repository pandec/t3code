import {
  AuthAdministrativeScopes,
  type ClientOrchestrationCommand,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  EnvironmentHttpConflictError,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type * as ServerConfig from "../config.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const isEnvironmentHttpConflictError = Schema.is(EnvironmentHttpConflictError);

export class CliOrchestrationDeclaredResponseError extends Schema.TaggedErrorClass<CliOrchestrationDeclaredResponseError>()(
  "CliOrchestrationDeclaredResponseError",
  {
    operation: Schema.Literal("callLiveServer"),
    code: Schema.String,
    traceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed (${this.code}, trace ${this.traceId}).`;
  }
}

export class CliOrchestrationUndeclaredStatusError extends Schema.TaggedErrorClass<CliOrchestrationUndeclaredStatusError>()(
  "CliOrchestrationUndeclaredStatusError",
  {
    operation: Schema.Literal("callLiveServer"),
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed with undeclared status ${this.status}.`;
  }
}

export class CliOrchestrationRequestError extends Schema.TaggedErrorClass<CliOrchestrationRequestError>()(
  "CliOrchestrationRequestError",
  {
    operation: Schema.Literal("callLiveServer"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to call the running server.";
  }
}

export class CliOrchestrationConflictError extends Schema.TaggedErrorClass<CliOrchestrationConflictError>()(
  "CliOrchestrationConflictError",
  {
    operation: Schema.Literal("callLiveServer"),
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class CliOrchestrationServerUnavailableError extends Schema.TaggedErrorClass<CliOrchestrationServerUnavailableError>()(
  "CliOrchestrationServerUnavailableError",
  {
    operation: Schema.Literal("resolveLiveServer"),
    statePath: Schema.String,
  },
) {
  override get message(): string {
    return "No running T3 Code server was found for this data directory.";
  }
}

export type CliOrchestrationCallError =
  | CliOrchestrationDeclaredResponseError
  | CliOrchestrationUndeclaredStatusError
  | CliOrchestrationRequestError
  | CliOrchestrationConflictError;

export function cliOrchestrationErrorFromRequest(cause: unknown): CliOrchestrationCallError {
  if (isEnvironmentHttpConflictError(cause)) {
    return new CliOrchestrationConflictError({
      operation: "callLiveServer",
      detail: cause.message,
      cause,
    });
  }
  if (isEnvironmentHttpCommonError(cause)) {
    return new CliOrchestrationDeclaredResponseError({
      operation: "callLiveServer",
      code: cause.code,
      traceId: cause.traceId,
      cause,
    });
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return new CliOrchestrationUndeclaredStatusError({
      operation: "callLiveServer",
      status: cause.response.status,
      cause,
    });
  }
  return new CliOrchestrationRequestError({ operation: "callLiveServer", cause });
}

const CLI_LIVE_SERVER_READ_TIMEOUT = Duration.seconds(1);
const withLiveServerReadTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(CLI_LIVE_SERVER_READ_TIMEOUT));

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  });

export const withCliOrchestrationSession = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  label: string,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({ scopes: AuthAdministrativeScopes, label }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

export const fetchLiveOrchestrationSnapshot = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.snapshot({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(withLiveServerReadTimeout, Effect.mapError(cliOrchestrationErrorFromRequest));

export const fetchLiveOrchestrationShell = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.shellSnapshot({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(withLiveServerReadTimeout, Effect.mapError(cliOrchestrationErrorFromRequest));

export const fetchLiveEnvironmentDescriptor = (origin: string) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.metadata.descriptor();
  }).pipe(withLiveServerReadTimeout, Effect.mapError(cliOrchestrationErrorFromRequest));

export const dispatchLiveOrchestrationCommand = (
  origin: string,
  bearerToken: string,
  command: ClientOrchestrationCommand,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.dispatch({
      headers: { authorization: `Bearer ${bearerToken}` },
      payload: command,
    } as Parameters<typeof client.orchestration.dispatch>[0]);
  }).pipe(Effect.mapError(cliOrchestrationErrorFromRequest));

export interface CliLiveOrchestrationServer {
  readonly origin: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly shell: OrchestrationShellSnapshot;
}

const isProcessAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      return !(
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ESRCH"
      );
    }
  });

const causeHasCode = (cause: unknown, code: string, seen = new Set<unknown>()): boolean => {
  if (typeof cause !== "object" || cause === null || seen.has(cause)) return false;
  seen.add(cause);
  if ("code" in cause && cause.code === code) return true;
  if ("cause" in cause && causeHasCode(cause.cause, code, seen)) return true;
  return "reason" in cause && causeHasCode(cause.reason, code, seen);
};

const isConnectionRefused = (error: unknown): boolean => causeHasCode(error, "ECONNREFUSED");

export const tryResolveLiveOrchestrationServer = Effect.fn("tryResolveLiveOrchestrationServer")(
  function* (
    environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
    config: ServerConfig.ServerConfig["Service"],
    label: string,
  ) {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return Option.none<CliLiveOrchestrationServer>();
    }

    const attempt = withCliOrchestrationSession(environmentAuth, label, (token) =>
      fetchLiveOrchestrationShell(runtimeState.value.origin, token).pipe(
        Effect.map((shell) => ({
          origin: runtimeState.value.origin,
          pid: runtimeState.value.pid,
          startedAt: runtimeState.value.startedAt,
          shell,
        })),
      ),
    );
    const attempted = yield* Effect.result(attempt);
    if (attempted._tag === "Success") {
      return Option.some(attempted.success);
    }

    yield* Effect.logDebug("Failed to connect to the persisted T3 CLI server.", {
      origin: runtimeState.value.origin,
      cause: attempted.failure,
    });
    if (
      !(yield* isProcessAlive(runtimeState.value.pid)) ||
      isConnectionRefused(attempted.failure)
    ) {
      yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
      return Option.none<CliLiveOrchestrationServer>();
    }

    return yield* attempted.failure;
  },
);

export const requireLiveOrchestrationServer = Effect.fn("requireLiveOrchestrationServer")(
  function* (
    environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
    config: ServerConfig.ServerConfig["Service"],
    label: string,
  ) {
    const live = yield* tryResolveLiveOrchestrationServer(environmentAuth, config, label);
    if (Option.isNone(live)) {
      return yield* new CliOrchestrationServerUnavailableError({
        operation: "resolveLiveServer",
        statePath: config.serverRuntimeStatePath,
      });
    }
    return live.value;
  },
);
