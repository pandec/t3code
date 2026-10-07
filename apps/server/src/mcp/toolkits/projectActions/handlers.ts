import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectActions from "../../../project/ProjectActions.ts";
import {
  readCaller,
  readFullAccessCaller,
  resolveProjectId,
  unavailable,
} from "../../threadAccess.ts";
import { ProjectActionsToolkit } from "./tools.ts";

const failure = (error: ProjectActions.ProjectActionsError) =>
  error._tag === "ProjectOperationError" || error._tag === "ServerSettingsError"
    ? unavailable()
    : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** Reading needs any orchestration caller; edits, like other project changes, need full access. */
const resolveTarget = (projectId: ProjectId | undefined, write: boolean) =>
  Effect.gen(function* () {
    const context = write
      ? yield* readFullAccessCaller(
          "Project action changes require a live full-access/default calling thread or a full-access client.",
        )
      : yield* readCaller();
    return yield* resolveProjectId(context, projectId);
  });

/** Fork: project actions toolkit. */
export const layer = ProjectActionsToolkit.toLayer({
  t3_project_actions_list: (input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveTarget(input.projectId, false);
      const actions = yield* ProjectActions.ProjectActions;
      return yield* actions.list(projectId).pipe(Effect.mapError(failure));
    }),
  t3_project_actions_upsert: (input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveTarget(input.projectId, true);
      const actions = yield* ProjectActions.ProjectActions;
      return yield* actions.upsert({ ...input, projectId }).pipe(Effect.mapError(failure));
    }),
  t3_project_actions_remove: (input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveTarget(input.projectId, true);
      const actions = yield* ProjectActions.ProjectActions;
      return yield* actions
        .remove({ projectId, actionId: input.actionId })
        .pipe(Effect.mapError(failure));
    }),
});
