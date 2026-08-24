import {
  AuthAdministrativeScopes,
  ClientOrchestrationCommand,
  DispatchResult,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  EnvironmentHttpConflictError,
  EnvironmentResourceNotFoundError,
  type MessageId,
  type OrchestrationShellSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
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

export class CliOrchestrationWaitOutcomeUnknownError extends Schema.TaggedErrorClass<CliOrchestrationWaitOutcomeUnknownError>()(
  "CliOrchestrationWaitOutcomeUnknownError",
  {
    operation: Schema.Literal("waitLiveServer"),
    pid: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The server stopped during the wait, so the thread's final outcome is unknown.";
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

export const CliLiveServerReadPhase = Schema.Literals([
  "discovery",
  "descriptor",
  "snapshot",
  "messages",
  "wait",
]);
export type CliLiveServerReadPhase = typeof CliLiveServerReadPhase.Type;

export class CliOrchestrationReadTimeoutError extends Schema.TaggedErrorClass<CliOrchestrationReadTimeoutError>()(
  "CliOrchestrationReadTimeoutError",
  {
    operation: Schema.Literal("callLiveServer"),
    phase: CliLiveServerReadPhase,
    timeoutMillis: Schema.Int,
  },
) {
  override get message(): string {
    return `The running server did not answer the ${this.phase} read within ${this.timeoutMillis}ms. Retry with a larger --timeout-ms (or T3CODE_CLI_TIMEOUT_MS) if the server is busy.`;
  }
}

const isCliOrchestrationOutcomeUnknownError = Schema.is(CliOrchestrationOutcomeUnknownError);
const isCliOrchestrationUndeclaredStatusError = Schema.is(CliOrchestrationUndeclaredStatusError);

export type CliOrchestrationCallError =
  | CliOrchestrationDeclaredResponseError
  | CliOrchestrationUndeclaredStatusError
  | CliOrchestrationRequestError
  | CliOrchestrationConflictError
  | CliOrchestrationReadTimeoutError;

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

const CLI_LIVE_SERVER_DISCOVERY_TIMEOUT_DEFAULT = Duration.seconds(3);
const CLI_LIVE_SERVER_READ_TIMEOUT_DEFAULT = Duration.seconds(10);
const CLI_LIVE_SERVER_DISPATCH_TIMEOUT_MS = 30_000;

export interface CliLiveServerReadTimeouts {
  readonly discovery: Duration.Duration;
  readonly read: Duration.Duration;
}

export const defaultCliLiveServerReadTimeouts: CliLiveServerReadTimeouts = {
  discovery: CLI_LIVE_SERVER_DISCOVERY_TIMEOUT_DEFAULT,
  read: CLI_LIVE_SERVER_READ_TIMEOUT_DEFAULT,
};

export const cliLiveServerReadTimeoutsFromMillis = (
  overrideMillis: number,
): CliLiveServerReadTimeouts => ({
  // An explicit override applies to every live read: the shell snapshot behind
  // thread/status commands runs under the discovery timeout, so clamping it to
  // the short default would make the override ineffective exactly when the
  // server is busy.
  discovery: Duration.millis(overrideMillis),
  read: Duration.millis(overrideMillis),
});

export const resolveCliLiveServerReadTimeouts = Effect.fn("resolveCliLiveServerReadTimeouts")(
  function* (flagTimeoutMillis: Option.Option<number>) {
    const envTimeoutMillis = yield* Config.int("T3CODE_CLI_TIMEOUT_MS").pipe(
      Config.option,
      Effect.catch(() =>
        Console.error("Ignoring invalid T3CODE_CLI_TIMEOUT_MS; using default timeouts.").pipe(
          Effect.as(Option.none<number>()),
        ),
      ),
    );
    const requestedOverrideMillis = Option.firstSomeOf([flagTimeoutMillis, envTimeoutMillis]);
    const overrideMillis = requestedOverrideMillis.pipe(
      Option.filter((value) => Number.isFinite(value) && value > 0),
    );
    if (Option.isSome(requestedOverrideMillis) && Option.isNone(overrideMillis)) {
      yield* Console.error(
        `Ignoring non-positive live-read timeout override (${requestedOverrideMillis.value}); using default timeouts.`,
      );
    }
    return Option.isSome(overrideMillis)
      ? cliLiveServerReadTimeoutsFromMillis(overrideMillis.value)
      : defaultCliLiveServerReadTimeouts;
  },
);

const withLiveServerReadTimeout =
  (phase: CliLiveServerReadPhase, duration: Duration.Duration) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration,
        orElse: () =>
          Effect.fail(
            new CliOrchestrationReadTimeoutError({
              operation: "callLiveServer",
              phase,
              timeoutMillis: Duration.toMillis(duration),
            }),
          ),
      }),
    );

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
    // An undeclared 5xx during dispatch can happen after the command committed
    // (a defect between commit and response encoding), so the outcome is
    // unknown; only sub-5xx statuses prove the command was rejected.
    const undeclaredDispatchFailure = (status: number, cause: unknown) =>
      status >= 500
        ? new CliOrchestrationOutcomeUnknownError({ operation: "dispatchLiveServer", cause })
        : new CliOrchestrationUndeclaredStatusError({
            operation: "callLiveServer",
            status,
            cause,
          });
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
            ? undeclaredDispatchFailure(
                responseStatus,
                new Error("Server error acknowledgement timed out."),
              )
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
            : undeclaredDispatchFailure(response.status, cause);
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

// The CLI issues auth sessions by writing to the same SQLite database the live
// server uses, so a busy server can surface as a transient SQLITE_BUSY here.
export const causeChainHasSqliteBusy = (cause: unknown, seen = new Set<unknown>()): boolean => {
  if (typeof cause !== "object" || cause === null || seen.has(cause)) return false;
  seen.add(cause);
  if ("code" in cause && cause.code === "SQLITE_BUSY") return true;
  if (
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.includes("database is locked")
  ) {
    return true;
  }
  if ("cause" in cause && causeChainHasSqliteBusy(cause.cause, seen)) return true;
  return "reason" in cause && causeChainHasSqliteBusy(cause.reason, seen);
};

const authSessionBusyRetryPolicy = {
  while: (error: unknown) => causeChainHasSqliteBusy(error),
  schedule: Schedule.exponential(Duration.millis(50)),
  times: 3,
};

export const withCliOrchestrationSession = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  label: string,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth
      .issueSession({ scopes: AuthAdministrativeScopes, label })
      .pipe(Effect.retry(authSessionBusyRetryPolicy)),
    (issued) => run(issued.token),
    (issued) =>
      environmentAuth
        .revokeSession(issued.sessionId)
        .pipe(Effect.retry(authSessionBusyRetryPolicy), Effect.ignore({ log: true })),
  );

export const fetchLiveOrchestrationSnapshot = (
  origin: string,
  bearerToken: string,
  timeouts: CliLiveServerReadTimeouts,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.snapshot({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(
    Effect.mapError(cliOrchestrationErrorFromRequest),
    withLiveServerReadTimeout("snapshot", timeouts.read),
  );

export const fetchLiveOrchestrationShell = (
  origin: string,
  bearerToken: string,
  timeouts: CliLiveServerReadTimeouts,
  options?: {
    readonly phase?: CliLiveServerReadPhase;
    readonly timeout?: Duration.Duration;
  },
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.shellSnapshot({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(
    Effect.mapError(cliOrchestrationErrorFromRequest),
    withLiveServerReadTimeout(
      options?.phase ?? "discovery",
      options?.timeout ?? timeouts.discovery,
    ),
  );

const isEnvironmentResourceNotFoundError = Schema.is(EnvironmentResourceNotFoundError);

export class CliOrchestrationThreadNotFoundError extends Schema.TaggedErrorClass<CliOrchestrationThreadNotFoundError>()(
  "CliOrchestrationThreadNotFoundError",
  {
    operation: Schema.Literal("fetchThreadMessages"),
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `No thread found for '${this.threadId}'.`;
  }
}

export const fetchLiveOrchestrationThreadMessages = (
  origin: string,
  bearerToken: string,
  input: {
    readonly threadId: ThreadId;
    readonly before?: MessageId;
    readonly limit?: number;
  },
  timeouts: CliLiveServerReadTimeouts,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.threadMessages({
      params: { threadId: input.threadId },
      query: {
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(
    Effect.mapError((cause) =>
      isEnvironmentResourceNotFoundError(cause)
        ? new CliOrchestrationThreadNotFoundError({
            operation: "fetchThreadMessages",
            threadId: input.threadId,
          })
        : cliOrchestrationErrorFromRequest(cause),
    ),
    withLiveServerReadTimeout("messages", timeouts.read),
  );

// A matched thread route always answers a missing thread with a typed
// not-found body, so a bare 404 means the server predates the route itself.
export const isLiveServerRouteMissing = (error: unknown): boolean =>
  isCliOrchestrationUndeclaredStatusError(error) && error.status === 404;

/** Full-history thread detail read, the fallback for servers that predate the
    dedicated `/messages` route (including upstream ones). */
export const fetchLiveOrchestrationThreadDetail = (
  origin: string,
  bearerToken: string,
  threadId: ThreadId,
  timeouts: CliLiveServerReadTimeouts,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.threadSnapshot({
      params: { threadId },
      query: {},
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(
    Effect.mapError((cause) =>
      isEnvironmentResourceNotFoundError(cause)
        ? new CliOrchestrationThreadNotFoundError({
            operation: "fetchThreadMessages",
            threadId,
          })
        : cliOrchestrationErrorFromRequest(cause),
    ),
    withLiveServerReadTimeout("messages", timeouts.read),
  );

export const fetchLiveEnvironmentDescriptor = (
  origin: string,
  timeouts: CliLiveServerReadTimeouts,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.metadata.descriptor();
  }).pipe(
    Effect.mapError(cliOrchestrationErrorFromRequest),
    withLiveServerReadTimeout("descriptor", timeouts.read),
  );

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
      // An undeclared 5xx can occur after the command committed, so the
      // outcome is unknown; sub-5xx statuses prove the command was rejected.
      if (response.status >= 500) {
        return yield* new CliOrchestrationOutcomeUnknownError({
          operation: "dispatchLiveServer",
          cause: responsePayload,
        });
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

export const isProcessAlive = (pid: number) =>
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

export const isConnectionRefused = (error: unknown): boolean => causeHasCode(error, "ECONNREFUSED");

export interface CliResolvedLiveOrchestrationInput {
  readonly environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly label: string;
  readonly timeouts: CliLiveServerReadTimeouts;
}

/**
 * Resolves the persisted live server and runs `use` against it inside a single
 * auth session, so discovery and the actual operation share one issue/revoke
 * cycle. Returns `Option.none` when no live server exists for this data
 * directory; a server that is alive but unresponsive fails with the discovery
 * error instead of being treated as absent.
 */
export const withResolvedLiveOrchestrationServer = Effect.fn("withResolvedLiveOrchestrationServer")(
  function* <A, E, R>(
    input: CliResolvedLiveOrchestrationInput,
    use: (live: CliLiveOrchestrationServer, token: string) => Effect.Effect<A, E, R>,
  ) {
    const runtimeState = yield* readPersistedServerRuntimeState(
      input.config.serverRuntimeStatePath,
    );
    if (Option.isNone(runtimeState)) {
      return Option.none<A>();
    }

    return yield* withCliOrchestrationSession(input.environmentAuth, input.label, (token) =>
      Effect.gen(function* () {
        const attempted = yield* Effect.result(
          fetchLiveOrchestrationShell(runtimeState.value.origin, token, input.timeouts),
        );
        if (attempted._tag === "Failure") {
          yield* Effect.logDebug("Failed to connect to the persisted T3 CLI server.", {
            origin: runtimeState.value.origin,
            cause: attempted.failure,
          });
          if (
            !(yield* isProcessAlive(runtimeState.value.pid)) ||
            isConnectionRefused(attempted.failure)
          ) {
            yield* clearPersistedServerRuntimeState(input.config.serverRuntimeStatePath);
            return Option.none<A>();
          }
          return yield* attempted.failure;
        }

        const live: CliLiveOrchestrationServer = {
          origin: runtimeState.value.origin,
          pid: runtimeState.value.pid,
          startedAt: runtimeState.value.startedAt,
          shell: attempted.success,
        };
        return Option.some(yield* use(live, token));
      }),
    );
  },
);
