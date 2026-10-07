/**
 * Fork: reads and edits a project's effective actions (the run buttons the UI
 * shows), which live in server settings rather than the project row. Writes
 * are a compare-and-set against the actions just read, under the settings
 * write lock, so a concurrent edit from another client is reported instead of
 * overwritten. Inherited default actions become the project's own override on
 * the first write. Keybindings are never touched.
 */
import {
  type ProjectId,
  type ProjectScript,
  type ProjectScriptIcon,
  ServerSettingsError,
} from "@t3tools/contracts";
import {
  buildProjectScript,
  nextProjectScriptId,
  normalizeProjectSetupScript,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";

export class ProjectActionsProjectNotFoundError extends Schema.TaggedError<ProjectActionsProjectNotFoundError>()(
  "ProjectActionsProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project '${this.projectId}' was not found.`;
  }
}

export class ProjectActionNotFoundError extends Schema.TaggedError<ProjectActionNotFoundError>()(
  "ProjectActionNotFoundError",
  {
    projectId: Schema.String,
    actionId: Schema.String,
    availableActionIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const available =
      this.availableActionIds.length === 0 ? "none" : this.availableActionIds.join(", ");
    return `No action '${this.actionId}' exists in project '${this.projectId}' (available: ${available}).`;
  }
}

export class ProjectActionValidationError extends Schema.TaggedError<ProjectActionValidationError>()(
  "ProjectActionValidationError",
  {
    field: Schema.Literals(["name", "command", "previewUrl", "autoOpenPreview"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid project action ${this.field}: ${this.detail}.`;
  }
}

/** Another client changed the project's actions after they were read. */
export class ProjectActionsConflictError extends Schema.TaggedError<ProjectActionsConflictError>()(
  "ProjectActionsConflictError",
  { projectId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Project '${this.projectId}' actions changed since they were read. List them again and retry.`;
  }
}

/** The settings file still holds unfolded legacy project settings. */
export class ProjectActionsUnavailableError extends Schema.TaggedError<ProjectActionsUnavailableError>()(
  "ProjectActionsUnavailableError",
  { projectId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Project actions cannot be edited until project settings are folded. Repair the settings file first.";
  }
}

export type ProjectActionsError =
  | ProjectActionsProjectNotFoundError
  | ProjectActionNotFoundError
  | ProjectActionValidationError
  | ProjectActionsConflictError
  | ProjectActionsUnavailableError
  | ProjectService.ProjectOperationError
  | ServerSettingsError;

export interface ProjectActionsList {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly actions: ReadonlyArray<ProjectScript>;
}

/** No `actionId` creates an action (name and command required); an `actionId` updates it. */
export interface ProjectActionUpsertInput {
  readonly projectId: ProjectId;
  readonly actionId?: string | undefined;
  readonly name?: string | undefined;
  readonly command?: string | undefined;
  readonly icon?: ProjectScriptIcon | undefined;
  readonly runOnWorktreeCreate?: boolean | undefined;
  readonly async?: boolean | undefined;
  /** `null` clears the preview URL and its auto-open setting. */
  readonly previewUrl?: string | null | undefined;
  readonly autoOpenPreview?: boolean | undefined;
}

export interface ProjectActionUpsertResult {
  readonly projectId: ProjectId;
  readonly action: "created" | "updated";
  readonly projectAction: ProjectScript;
  /** Actions whose run-on-worktree-create flag was cleared; only one action may hold it. */
  readonly clearedRunOnWorktreeCreate: ReadonlyArray<string>;
}

export interface ProjectActionRemoveResult {
  readonly projectId: ProjectId;
  readonly action: "removed";
  readonly actionId: string;
}

export class ProjectActions extends Context.Service<
  ProjectActions,
  {
    readonly list: (projectId: ProjectId) => Effect.Effect<ProjectActionsList, ProjectActionsError>;
    readonly upsert: (
      input: ProjectActionUpsertInput,
    ) => Effect.Effect<ProjectActionUpsertResult, ProjectActionsError>;
    readonly remove: (input: {
      readonly projectId: ProjectId;
      readonly actionId: string;
    }) => Effect.Effect<ProjectActionRemoveResult, ProjectActionsError>;
  }
>()("t3/project/ProjectActions") {}

const requiredText = (field: "name" | "command", value: string) => {
  const trimmed = value.trim();
  return trimmed.length > 0
    ? Effect.succeed(trimmed)
    : Effect.fail(new ProjectActionValidationError({ field, detail: "cannot be empty" }));
};

/** `undefined` keeps `current`, `null` clears, a string sets a trimmed non-empty URL. */
const previewUrlValue = (value: string | null | undefined, current: string | null) => {
  if (value === undefined) return Effect.succeed(current);
  if (value === null) return Effect.succeed(null);
  const trimmed = value.trim();
  return trimmed.length > 0
    ? Effect.succeed(trimmed)
    : Effect.fail(
        new ProjectActionValidationError({
          field: "previewUrl",
          detail: "cannot be empty; pass null to clear it",
        }),
      );
};

const findAction = (
  projectId: ProjectId,
  scripts: ReadonlyArray<ProjectScript>,
  actionId: string,
) => {
  const trimmed = actionId.trim();
  const action = scripts.find((candidate) => candidate.id === trimmed);
  return action !== undefined
    ? Effect.succeed(action)
    : Effect.fail(
        new ProjectActionNotFoundError({
          projectId,
          actionId: trimmed,
          availableActionIds: scripts.map((candidate) => candidate.id),
        }),
      );
};

/** The next action list for an upsert; ids derive from the name and never collide. */
const applyUpsert = Effect.fn("ProjectActions.applyUpsert")(function* (
  scripts: ReadonlyArray<ProjectScript>,
  input: ProjectActionUpsertInput,
) {
  const current =
    input.actionId === undefined
      ? undefined
      : yield* findAction(input.projectId, scripts, input.actionId);
  if (current === undefined && (input.name === undefined || input.command === undefined)) {
    return yield* new ProjectActionValidationError({
      field: input.name === undefined ? "name" : "command",
      detail: "is required to create an action",
    });
  }
  const name = input.name === undefined ? current!.name : yield* requiredText("name", input.name);
  const command =
    input.command === undefined ? current!.command : yield* requiredText("command", input.command);
  const previewUrl = yield* previewUrlValue(input.previewUrl, current?.previewUrl ?? null);
  if (input.autoOpenPreview === true && previewUrl === null) {
    return yield* new ProjectActionValidationError({
      field: "autoOpenPreview",
      detail: "requires a preview URL",
    });
  }
  const async = input.async ?? current?.async;
  const projectAction = buildProjectScript(
    current?.id ??
      nextProjectScriptId(
        name,
        scripts.map((script) => script.id),
      ),
    {
      name,
      command,
      icon: input.icon ?? current?.icon ?? "play",
      runOnWorktreeCreate: input.runOnWorktreeCreate ?? current?.runOnWorktreeCreate ?? false,
      ...(async === undefined ? {} : { async }),
      // Not editable here; an edit keeps the action's settle role.
      runOnSettle: current?.runOnSettle === true,
      previewUrl,
      autoOpenPreview:
        previewUrl === null ? false : (input.autoOpenPreview ?? current?.autoOpenPreview ?? false),
    },
  );
  const next =
    current === undefined
      ? [...scripts, projectAction]
      : scripts.map((candidate) => (candidate.id === current.id ? projectAction : candidate));
  const normalized = normalizeProjectSetupScript(next, projectAction.id);
  return {
    projectAction,
    created: current === undefined,
    scripts: normalized.scripts,
    clearedRunOnWorktreeCreate: normalized.clearedActionIds,
  };
});

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;

  const read = Effect.fn("ProjectActions.read")(function* (projectId: ProjectId) {
    const project = yield* projects.getById(projectId);
    if (Option.isNone(project)) {
      return yield* new ProjectActionsProjectNotFoundError({ projectId });
    }
    const scripts = resolveProjectScripts(yield* settings.getSettings, project.value);
    return { project: project.value, scripts };
  });

  /** Compare-and-set against the actions `read` returned. */
  const write = (
    projectId: ProjectId,
    expectedScripts: ReadonlyArray<ProjectScript>,
    scripts: ReadonlyArray<ProjectScript>,
  ) =>
    settings
      .updateSettings({
        projectScriptUpdate: {
          projectId,
          expectedScripts: Array.from(expectedScripts),
          scripts: Array.from(scripts),
        },
      })
      .pipe(
        Effect.catchTags({
          ServerSettingsError: (cause) =>
            cause.operation === "project-actions-conflict"
              ? Effect.fail(new ProjectActionsConflictError({ projectId, cause }))
              : cause.operation === "project-actions-unavailable"
                ? Effect.fail(new ProjectActionsUnavailableError({ projectId, cause }))
                : Effect.fail(cause),
        }),
        Effect.asVoid,
      );

  return ProjectActions.of({
    list: Effect.fn("ProjectActions.list")(function* (projectId) {
      const { project, scripts } = yield* read(projectId);
      return {
        projectId: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        actions: scripts,
      };
    }),
    upsert: Effect.fn("ProjectActions.upsert")(function* (input) {
      const { project, scripts } = yield* read(input.projectId);
      const result = yield* applyUpsert(scripts, input);
      yield* write(project.id, scripts, result.scripts);
      return {
        projectId: project.id,
        action: result.created ? "created" : "updated",
        projectAction: result.projectAction,
        clearedRunOnWorktreeCreate: result.clearedRunOnWorktreeCreate,
      } as const;
    }),
    remove: Effect.fn("ProjectActions.remove")(function* (input) {
      const { project, scripts } = yield* read(input.projectId);
      const action = yield* findAction(project.id, scripts, input.actionId);
      yield* write(
        project.id,
        scripts,
        scripts.filter((candidate) => candidate.id !== action.id),
      );
      return { projectId: project.id, action: "removed", actionId: action.id } as const;
    }),
  });
});

export const layer = Layer.effect(ProjectActions, make);
