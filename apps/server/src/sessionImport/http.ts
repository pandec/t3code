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

/** Authenticated session import for the CLI: candidates need read, import needs operate. */
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
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const candidates = yield* sessionImport
            .listCandidates(args.payload)
            .pipe(Effect.mapError(toHttpError));
          return { candidates };
        }),
      )
      .handle(
        "importSession",
        Effect.fn("environment.sessionImport.import")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          // Forward the decoded payload verbatim: re-listing its optional
          // fields here silently drops any field added later.
          return yield* sessionImport
            .importSession(args.payload)
            .pipe(Effect.mapError(toHttpError));
        }),
      );
  }),
);
