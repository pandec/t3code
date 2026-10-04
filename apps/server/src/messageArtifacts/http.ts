import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { MessageSummary } from "./MessageSummary.ts";

export const messageArtifactsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "messageArtifacts",
  Effect.fnUntraced(function* (handlers) {
    const messageSummary = yield* MessageSummary;
    return handlers.handle(
      "summarizeMessage",
      Effect.fn("environment.messageArtifacts.summarizeMessage")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
        return yield* messageSummary.summarize(args.payload).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              switch (error.reason) {
                case "message_unavailable":
                  return yield* failEnvironmentInvalidRequest("summary_message_unavailable");
                case "source_too_long":
                  return yield* failEnvironmentInvalidRequest("summary_source_too_long");
                case "provider_unavailable":
                case "generation_failed":
                  return yield* failEnvironmentInternal("summary_generation_failed", error);
                case "storage_failed":
                  return yield* failEnvironmentInternal("internal_error", error);
              }
            }),
          ),
        );
      }),
    );
  }),
);
