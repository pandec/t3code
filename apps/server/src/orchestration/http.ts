import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
  type EnvironmentOrchestrationThreadMessagesUrlParams,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { TurnStartBootstrap } from "./Services/TurnStartBootstrap.ts";

const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

/**
 * Handler body for GET /api/orchestration/threads/:threadId/messages,
 * exported standalone so route tests can exercise auth, 404, and clamping
 * behavior against a provided ProjectionSnapshotQuery layer without booting
 * the full HTTP API. Reads through
 * ProjectionSnapshotQuery.getThreadMessagePage — a dedicated bounded SQL
 * query (cursor+limit pushdown, ORDER BY created_at, message_id) — instead
 * of hydrating the full thread-detail snapshot just to page messages.
 */
export const getThreadMessagesHttp = Effect.fn("environment.orchestration.threadMessages.handler")(
  function* (
    params: { readonly threadId: ThreadId },
    query: EnvironmentOrchestrationThreadMessagesUrlParams,
  ) {
    yield* requireEnvironmentScope(AuthOrchestrationReadScope);
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const page = yield* projectionSnapshotQuery
      .getThreadMessagePage(params.threadId, query)
      .pipe(
        Effect.catch((cause) =>
          failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
        ),
      );
    if (Option.isNone(page)) {
      return yield* failEnvironmentNotFound("thread_not_found");
    }
    return page.value;
  },
);

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const turnStartBootstrap = yield* TurnStartBootstrap;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(snapshot.value, args.query);
        }),
      )
      .handle(
        "threadMessages",
        Effect.fn("environment.orchestration.threadMessages")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* getThreadMessagesHttp(args.params, args.query);
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          // Route bootstrap turn starts through the shared bootstrap program so
          // HTTP clients (the CLI) get worktree preparation, setup script
          // launch, and thread cleanup — identical to the WebSocket path.
          if (normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap) {
            return yield* turnStartBootstrap
              .dispatchTurnStart(normalizedCommand)
              .pipe(
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_dispatch_failed", cause),
                ),
              );
          }
          return yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                if (
                  isOrchestrationCommandInvariantError(cause) &&
                  (cause.code === "project_actions_changed" ||
                    cause.code === "project_actions_precondition_required")
                ) {
                  return yield* new EnvironmentHttpConflictError({
                    message:
                      cause.code === "project_actions_changed"
                        ? "Project actions changed after they were read. List them and retry."
                        : "This client cannot safely update project actions. Update or refresh T3 Code, then retry.",
                  });
                }
                return yield* failEnvironmentInternal("orchestration_dispatch_failed", cause);
              }),
            ),
          );
        }),
      );
  }),
);
