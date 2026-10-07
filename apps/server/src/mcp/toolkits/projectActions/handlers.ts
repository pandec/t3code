import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectActions from "../../../project/ProjectActions.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectActionsToolkit } from "./tools.ts";

const failure = (error: ProjectActions.ProjectActionsError) =>
  error._tag === "ProjectOperationError" || error._tag === "ServerSettingsError"
    ? unavailable()
    : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const resolveTarget = (projectId: ProjectId | undefined) =>
  readCaller().pipe(Effect.flatMap((context) => resolveProjectId(context, projectId)));

/**
 * Fork: project actions toolkit. Listing reads; edits, like other project
 * changes, need a full-access caller. Edits compare-and-set against the
 * actions they read, so a concurrent change is refused rather than lost.
 */
export const layer = McpToolAccess.toLayer(ProjectActionsToolkit, {
  t3_project_actions_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveTarget(input.projectId);
      const actions = yield* ProjectActions.ProjectActions;
      return yield* actions.list(projectId).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_actions_upsert: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveTarget(input.projectId);
      const actions = yield* ProjectActions.ProjectActions;
      return yield* actions.upsert({ ...input, projectId }).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_actions_remove: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveTarget(input.projectId);
      const actions = yield* ProjectActions.ProjectActions;
      return yield* actions
        .remove({ projectId, actionId: input.actionId })
        .pipe(Effect.mapError(failure));
    }),
  ),
});
