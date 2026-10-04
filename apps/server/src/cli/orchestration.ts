import {
  AuthAdministrativeScopes,
  ServerSettings,
  ServerSettingsPatch,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  EnvironmentHttpConflictError,
  EnvironmentResourceNotFoundError,
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

const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);
const encodeSettingsPatchJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ patch: ServerSettingsPatch })),
);

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const isEnvironmentHttpConflictError = Schema.is(EnvironmentHttpConflictError);
const decodeEnvironmentHttpCommonError = Schema.decodeUnknownOption(EnvironmentHttpCommonError);
const decodeEnvironmentHttpConflictError = Schema.decodeUnknownOption(EnvironmentHttpConflictError);

export class CliOrchestrationDeclaredResponseError extends Schema.TaggedError<CliOrchestrationDeclaredResponseError>()(
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

export class CliOrchestrationUndeclaredStatusError extends Schema.TaggedError<CliOrchestrationUndeclaredStatusError>()(
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

export class CliOrchestrationRequestError extends Schema.TaggedError<CliOrchestrationRequestError>()(
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

export class CliOrchestrationConflictError extends Schema.TaggedError<CliOrchestrationConflictError>()(
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

export class CliOrchestrationOutcomeUnknownError extends Schema.TaggedError<CliOrchestrationOutcomeUnknownError>()(
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

export class CliOrchestrationWaitOutcomeUnknownError extends Schema.TaggedError<CliOrchestrationWaitOutcomeUnknownError>()(
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

export class CliOrchestrationServerUnavailableError extends Schema.TaggedError<CliOrchestrationServerUnavailableError>()(
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

export class CliOrchestrationReadTimeoutError extends Schema.TaggedError<CliOrchestrationReadTimeoutError>()(
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
    const envTimeoutMillis = yield* Config.Int("T3CODE_CLI_TIMEOUT_MS").pipe(
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
  request: { readonly path: string; readonly method: "POST" | "PATCH"; readonly body: string },
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
      .fetch(new URL(request.path, origin), {
        method: request.method,
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
        },
        body: request.body,
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

export const fetchLiveServerSettings = (
  origin: string,
  bearerToken: string,
  timeouts: CliLiveServerReadTimeouts,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.settings.getSettings({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(
    Effect.mapError(cliOrchestrationErrorFromRequest),
    withLiveServerReadTimeout("snapshot", timeouts.read),
  );

const isEnvironmentResourceNotFoundError = Schema.is(EnvironmentResourceNotFoundError);

export class CliOrchestrationThreadNotFoundError extends Schema.TaggedError<CliOrchestrationThreadNotFoundError>()(
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

export const updateLiveServerSettings = (
  origin: string,
  bearerToken: string,
  patch: ServerSettingsPatch,
  options?: {
    readonly timeoutMilliseconds?: number;
  },
) =>
  Effect.gen(function* () {
    const { response, payload: responsePayload } = yield* fetchDispatchAcknowledgement(
      origin,
      bearerToken,
      { path: "/api/settings", method: "PATCH", body: encodeSettingsPatchJson({ patch }) },
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
    return yield* decodeServerSettings(responsePayload).pipe(
      Effect.mapError(
        (cause) =>
          new CliOrchestrationOutcomeUnknownError({
            operation: "dispatchLiveServer",
            cause,
          }),
      ),
    );
  });

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
