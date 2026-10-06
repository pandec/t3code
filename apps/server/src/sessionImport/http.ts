import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentSessionImportError,
  type SessionImportError,
  type SessionImportForkThreadPayload,
  type SessionImportListCandidatesPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { type SessionImportInput, SessionImportService } from "./SessionImportService.ts";

const toHttpError = (error: SessionImportError) =>
  new EnvironmentSessionImportError({
    code: "session_import_error",
    reason: error.reason,
    detail: error.detail,
    ...(error.existingThreadId === undefined ? {} : { existingThreadId: error.existingThreadId }),
  });

/** Listing candidates needs the read scope. */
export const listSessionImportCandidatesHttp = Effect.fn("environment.sessionImport.candidates")(
  function* (payload: SessionImportListCandidatesPayload) {
    yield* requireEnvironmentScope(AuthOrchestrationReadScope);
    const sessionImport = yield* SessionImportService;
    const candidates = yield* sessionImport
      .listCandidates(payload)
      .pipe(Effect.mapError(toHttpError));
    return { candidates };
  },
);

/** Importing creates a thread, so it needs the operate scope. */
export const importSessionHttp = Effect.fn("environment.sessionImport.import")(function* (
  payload: SessionImportInput,
) {
  yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
  const sessionImport = yield* SessionImportService;
  // Forward the decoded payload verbatim: re-listing its optional fields here
  // silently drops any field added later.
  return yield* sessionImport.importSession(payload).pipe(Effect.mapError(toHttpError));
});

/** Forking an imported thread creates a thread, so it needs the operate scope. */
export const forkImportedThreadHttp = Effect.fn("environment.sessionImport.forkThread")(function* (
  payload: SessionImportForkThreadPayload,
) {
  yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
  const sessionImport = yield* SessionImportService;
  return yield* sessionImport.forkImportedThread(payload).pipe(Effect.mapError(toHttpError));
});

/** Authenticated session import for the CLI. */
export const sessionImportHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "sessionImport",
  Effect.fnUntraced(function* (handlers) {
    const sessionImport = yield* SessionImportService;
    const provide = Effect.provideService(SessionImportService, sessionImport);
    return handlers
      .handle("candidates", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(
          Effect.andThen(listSessionImportCandidatesHttp(args.payload)),
          provide,
        ),
      )
      .handle("importSession", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(
          Effect.andThen(importSessionHttp(args.payload)),
          provide,
        ),
      )
      .handle("forkThread", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(
          Effect.andThen(forkImportedThreadHttp(args.payload)),
          provide,
        ),
      );
  }),
);
