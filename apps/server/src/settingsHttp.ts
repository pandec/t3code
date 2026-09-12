import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  requireEnvironmentScope,
  failEnvironmentInternal,
} from "./auth/http.ts";
import { ServerSettingsService, redactServerSettingsForClient } from "./serverSettings.ts";

export const settingsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "settings",
  Effect.fnUntraced(function* (handlers) {
    const settings = yield* ServerSettingsService;
    return handlers
      .handle(
        "getSettings",
        Effect.fn("environment.settings.getSettings")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* settings.getSettings.pipe(
            Effect.map(redactServerSettingsForClient),
            Effect.catch((cause) => failEnvironmentInternal("settings_read_failed", cause)),
          );
        }),
      )
      .handle(
        "updateSettings",
        Effect.fn("environment.settings.updateSettings")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* settings.updateSettings(args.payload.patch).pipe(
            Effect.map(redactServerSettingsForClient),
            Effect.catch((cause) =>
              Effect.gen(function* () {
                return yield* cause.operation === "project-actions-conflict" ||
                cause.operation === "project-actions-unavailable"
                  ? Effect.fail(
                      new EnvironmentHttpConflictError({
                        message:
                          cause.operation === "project-actions-conflict"
                            ? "Project actions changed after they were read. List them and retry."
                            : "Project settings are unavailable. Repair the settings file and retry.",
                      }),
                    )
                  : failEnvironmentInternal("settings_update_failed", cause);
              }),
            ),
          );
        }),
      );
  }),
);
