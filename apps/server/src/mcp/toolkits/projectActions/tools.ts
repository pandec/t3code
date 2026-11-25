import {
  OrchestratorMcpFailure,
  ProjectId,
  ProjectScript,
  ProjectScriptIcon,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectActions from "../../../project/ProjectActions.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * Fork: edit the project actions (run buttons) the app shows. They live in
 * server settings, not in the project row `t3_project_update` writes.
 */
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectActions.ProjectActions,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};

const projectId = Schema.optional(
  ProjectId.annotate({ description: "Target project. Defaults to the calling thread's project." }),
);

const ProjectActionsUpsertTool = Tool.make("t3_project_actions_upsert", {
  ...shared,
  description:
    "Create or update a project action. Omit actionId to create one (name and command required; its id derives from the name). Pass an actionId from the project's scripts (t3_project_read with an explicit projectId) to update it; omitted fields keep their values. Only one action may run on worktree creation: setting runOnWorktreeCreate clears it elsewhere and reports those ids in clearedRunOnWorktreeCreate. Inherited default actions become this project's own actions on the first change. The read and write are atomic, but scripts read earlier can be stale: read them again before updating when another client may have edited the actions. Fails with a conflict when they change mid-write; read them again and retry. Requires a full-access/default caller.",
  parameters: Schema.Struct({
    projectId,
    actionId: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "Existing action id to update." }),
    ),
    name: Schema.optional(TrimmedNonEmptyString),
    command: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "Shell command the action runs." }),
    ),
    icon: Schema.optional(ProjectScriptIcon),
    runOnWorktreeCreate: Schema.optional(
      Schema.Boolean.annotate({ description: "Run automatically after creating a worktree." }),
    ),
    async: Schema.optional(
      Schema.Boolean.annotate({
        description: "For a worktree setup action: let the agent start while it runs.",
      }),
    ),
    previewUrl: Schema.optional(
      Schema.NullOr(TrimmedNonEmptyString).annotate({
        description: "Desktop preview URL to open for the action. null removes it.",
      }),
    ),
    autoOpenPreview: Schema.optional(
      Schema.Boolean.annotate({ description: "Open the preview URL automatically." }),
    ),
  }),
  success: Schema.Struct({
    projectId: ProjectId,
    action: Schema.Literals(["created", "updated"]),
    projectAction: ProjectScript,
    clearedRunOnWorktreeCreate: Schema.Array(Schema.String),
  }),
})
  .annotate(Tool.Title, "Create or update a project action")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

const ProjectActionsRemoveTool = Tool.make("t3_project_actions_remove", {
  ...shared,
  description:
    "Remove a project action by its id from the project's scripts (t3_project_read with an explicit projectId). Fails if the actions changed since they were read; read them again and retry. Requires a full-access/default caller.",
  parameters: Schema.Struct({ projectId, actionId: TrimmedNonEmptyString }),
  success: Schema.Struct({
    projectId: ProjectId,
    action: Schema.Literal("removed"),
    actionId: Schema.String,
  }),
})
  .annotate(Tool.Title, "Remove a project action")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

export const ProjectActionsToolkit = Toolkit.make(
  ProjectActionsUpsertTool,
  ProjectActionsRemoveTool,
);
