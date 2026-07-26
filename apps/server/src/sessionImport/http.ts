import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentSessionImportError,
  type SessionImportError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { SessionImportService } from "./SessionImportService.ts";

const toHttpError = (error: SessionImportError) =>
  new EnvironmentSessionImportError({
    code: "session_import_error",
    reason: error.reason,
    detail: error.detail,
    ...(error.existingThreadId === undefined ? {} : { existingThreadId: error.existingThreadId }),
  });

export const listSessionImportCandidatesHttp = Effect.fn(
  "environment.sessionImport.listCandidates",
)(function* (payload: {
  readonly projectId: Parameters<SessionImportService["Service"]["listCandidates"]>[0]["projectId"];
  readonly cwd?: string | undefined;
}) {
  yield* requireEnvironmentScope(AuthOrchestrationReadScope);
  const sessionImport = yield* SessionImportService;
  const candidates = yield* sessionImport
    .listCandidates({
      projectId: payload.projectId,
      ...(payload.cwd === undefined ? {} : { cwd: payload.cwd }),
    })
    .pipe(Effect.mapError(toHttpError));
  return { candidates };
});

export const importSessionHttp = Effect.fn("environment.sessionImport.import")(function* (
  payload: Parameters<SessionImportService["Service"]["importSession"]>[0],
) {
  yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
  const sessionImport = yield* SessionImportService;
  return yield* sessionImport.importSession(payload).pipe(Effect.mapError(toHttpError));
});

export const sessionImportHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "sessionImport",
  Effect.fnUntraced(function* (handlers) {
    const sessionImport = yield* SessionImportService;
    return handlers
      .handle(
        "candidates",
        Effect.fn("environment.sessionImport.candidates")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* listSessionImportCandidatesHttp(args.payload).pipe(
            Effect.provideService(SessionImportService, sessionImport),
          );
        }),
      )
      .handle(
        "importSession",
        Effect.fn("environment.sessionImport.import")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // Forward the decoded payload verbatim: the contract's optional fields
          // (title, modelSelection, worktree) are the service input, and
          // re-listing them here silently drops any field added later.
          return yield* importSessionHttp(args.payload).pipe(
            Effect.provideService(SessionImportService, sessionImport),
          );
        }),
      );
  }),
);
