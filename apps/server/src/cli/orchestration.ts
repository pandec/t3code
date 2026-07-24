import {
  AuthAdministrativeScopes,
  ClientOrchestrationCommand,
  DispatchResult,
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
const decodeEnvironmentHttpCommonError = Schema.decodeUnknownOption(EnvironmentHttpCommonError);
const decodeEnvironmentHttpConflictError = Schema.decodeUnknownOption(EnvironmentHttpConflictError);
const decodeDispatchResult = Schema.decodeUnknownEffect(DispatchResult);
const encodeClientOrchestrationCommandJson = Schema.encodeSync(
  Schema.fromJsonString(ClientOrchestrationCommand),
);

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

export class CliOrchestrationOutcomeUnknownError extends Schema.TaggedErrorClass<CliOrchestrationOutcomeUnknownError>()(
  "CliOrchestrationOutcomeUnknownError",
  {
    operation: Schema.Literal("dispatchLiveServer"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The server acknowledgement was lost, so this command may have completed. Inspect the current state before retrying.";
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

const isCliOrchestrationOutcomeUnknownError = Schema.is(CliOrchestrationOutcomeUnknownError);
const isCliOrchestrationUndeclaredStatusError = Schema.is(CliOrchestrationUndeclaredStatusError);

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
const CLI_LIVE_SERVER_DISPATCH_TIMEOUT_MS = 30_000;
const withLiveServerReadTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(CLI_LIVE_SERVER_READ_TIMEOUT));

interface DispatchAcknowledgement {
  readonly response: Response;
  readonly payload: unknown;
}

const fetchDispatchAcknowledgement = (
  origin: string,
  bearerToken: string,
  command: ClientOrchestrationCommand,
  timeoutMilliseconds: number,
): Effect.Effect<
  DispatchAcknowledgement,
  CliOrchestrationOutcomeUnknownError | CliOrchestrationUndeclaredStatusError
> =>
  Effect.callback((resume) => {
    let settled = false;
    let responseStatus: number | undefined;
    let responseOk: boolean | undefined;
    const controller = new AbortController();
    const finish = (
      result: Effect.Effect<
        DispatchAcknowledgement,
        CliOrchestrationOutcomeUnknownError | CliOrchestrationUndeclaredStatusError
      >,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resume(result);
    };
    // @effect-diagnostics-next-line globalTimersInEffect:off - transport acknowledgement needs a hard deadline even when fetch ignores interruption.
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      resume(
        Effect.fail(
          responseOk === false && responseStatus !== undefined
            ? new CliOrchestrationUndeclaredStatusError({
                operation: "callLiveServer",
                status: responseStatus,
                cause: new Error("Server error acknowledgement timed out."),
              })
            : new CliOrchestrationOutcomeUnknownError({
                operation: "dispatchLiveServer",
                cause: new Error("Server acknowledgement timed out."),
              }),
        ),
      );
    }, timeoutMilliseconds);
    // @effect-diagnostics-next-line globalFetchInEffect:off - explicit AbortController ownership is required to bound acknowledgement body reads.
    globalThis
      .fetch(new URL("/api/orchestration/dispatch", origin), {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
        },
        body: encodeClientOrchestrationCommandJson(command),
        signal: controller.signal,
      })
      .then(async (response) => {
        responseStatus = response.status;
        responseOk = response.ok;
        try {
          return {
            response,
            payload: await response.json(),
          };
        } catch (cause) {
          throw response.ok
            ? new CliOrchestrationOutcomeUnknownError({
                operation: "dispatchLiveServer",
                cause,
              })
            : new CliOrchestrationUndeclaredStatusError({
                operation: "callLiveServer",
                status: response.status,
                cause,
              });
        }
      })
      .then(
        (acknowledgement) => finish(Effect.succeed(acknowledgement)),
        (cause: unknown) =>
          finish(
            Effect.fail(
              isCliOrchestrationOutcomeUnknownError(cause) ||
                isCliOrchestrationUndeclaredStatusError(cause)
                ? cause
                : new CliOrchestrationOutcomeUnknownError({
                    operation: "dispatchLiveServer",
                    cause,
                  }),
            ),
          ),
      );
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      controller.abort();
    });
  });

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
  options?: {
    readonly timeoutMilliseconds?: number;
  },
) =>
  Effect.gen(function* () {
    const { response, payload: responsePayload } = yield* fetchDispatchAcknowledgement(
      origin,
      bearerToken,
      command,
      options?.timeoutMilliseconds === undefined
        ? CLI_LIVE_SERVER_DISPATCH_TIMEOUT_MS
        : options.timeoutMilliseconds,
    );
    if (!response.ok) {
      const conflict = decodeEnvironmentHttpConflictError(responsePayload);
      if (Option.isSome(conflict)) {
        return yield* cliOrchestrationErrorFromRequest(conflict.value);
      }
      const declared = decodeEnvironmentHttpCommonError(responsePayload);
      if (Option.isSome(declared)) {
        return yield* cliOrchestrationErrorFromRequest(declared.value);
      }
      return yield* new CliOrchestrationUndeclaredStatusError({
        operation: "callLiveServer",
        status: response.status,
        cause: responsePayload,
      });
    }
    return yield* decodeDispatchResult(responsePayload).pipe(
      Effect.mapError(
        (cause) =>
          new CliOrchestrationOutcomeUnknownError({
            operation: "dispatchLiveServer",
            cause,
          }),
      ),
    );
  });

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
