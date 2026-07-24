import {
  MAX_SCRIPT_ID_LENGTH,
  ProjectId,
  SCRIPT_RUN_COMMAND_PATTERN,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  buildProjectScript,
  nextProjectScriptId,
  normalizeProjectSetupScript,
} from "@t3tools/shared/projectScripts";
import * as Schema from "effect/Schema";

const isProjectScriptCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

export class ProjectActionNotFoundError extends Schema.TaggedErrorClass<ProjectActionNotFoundError>()(
  "ProjectActionNotFoundError",
  {
    projectId: ProjectId,
    actionId: Schema.String,
    availableActionIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No action '${this.actionId}' exists in project '${this.projectId}'.`;
  }
}

export class ProjectActionAlreadyExistsError extends Schema.TaggedErrorClass<ProjectActionAlreadyExistsError>()(
  "ProjectActionAlreadyExistsError",
  {
    projectId: ProjectId,
    actionId: Schema.String,
  },
) {
  override get message(): string {
    return `Action '${this.actionId}' already exists in project '${this.projectId}'.`;
  }
}

export class ProjectActionValidationError extends Schema.TaggedErrorClass<ProjectActionValidationError>()(
  "ProjectActionValidationError",
  {
    field: Schema.Literals(["id", "name", "command", "previewUrl", "autoOpenPreview"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid project action ${this.field}: ${this.detail}`;
  }
}

export interface AddProjectActionInput {
  readonly id?: string;
  readonly name: string;
  readonly command: string;
  readonly icon: ProjectScript["icon"];
  readonly runOnWorktreeCreate: boolean;
  readonly previewUrl?: string;
  readonly autoOpenPreview: boolean;
}

export interface UpdateProjectActionInput {
  readonly name?: string;
  readonly command?: string;
  readonly icon?: ProjectScript["icon"];
  readonly runOnWorktreeCreate?: boolean;
  readonly previewUrl?: string | null;
  readonly autoOpenPreview?: boolean;
}

export interface ProjectActionMutationResult {
  readonly action: ProjectScript;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly clearedRunOnWorktreeCreate: ReadonlyArray<string>;
}

function validateActionId(id: string): string | ProjectActionValidationError {
  const trimmed = id.trim();
  if (!isProjectScriptCommand(`script.${trimmed}.run`)) {
    return new ProjectActionValidationError({
      field: "id",
      detail: `must match [a-z0-9][a-z0-9-]* and be at most ${MAX_SCRIPT_ID_LENGTH} characters`,
    });
  }
  return trimmed;
}

function requiredTrimmed(
  field: "name" | "command",
  value: string,
): string | ProjectActionValidationError {
  const trimmed = value.trim();
  return trimmed.length > 0
    ? trimmed
    : new ProjectActionValidationError({ field, detail: "cannot be empty" });
}

function optionalPreviewUrl(
  value: string | undefined,
): string | null | ProjectActionValidationError {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0
    ? trimmed
    : new ProjectActionValidationError({
        field: "previewUrl",
        detail: "cannot be empty; omit the flag instead",
      });
}

function findAction(
  projectId: ProjectId,
  scripts: ReadonlyArray<ProjectScript>,
  actionId: string,
): ProjectScript | ProjectActionNotFoundError {
  const trimmedActionId = actionId.trim();
  const action = scripts.find((candidate) => candidate.id === trimmedActionId);
  return (
    action ??
    new ProjectActionNotFoundError({
      projectId,
      actionId: trimmedActionId,
      availableActionIds: scripts.map((candidate) => candidate.id),
    })
  );
}

export function addProjectAction(input: {
  readonly projectId: ProjectId;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly action: AddProjectActionInput;
}): ProjectActionMutationResult | ProjectActionAlreadyExistsError | ProjectActionValidationError {
  const name = requiredTrimmed("name", input.action.name);
  if (typeof name !== "string") return name;
  const command = requiredTrimmed("command", input.action.command);
  if (typeof command !== "string") return command;
  const previewUrl = optionalPreviewUrl(input.action.previewUrl);
  if (previewUrl !== null && typeof previewUrl !== "string") return previewUrl;
  if (input.action.autoOpenPreview && previewUrl === null) {
    return new ProjectActionValidationError({
      field: "autoOpenPreview",
      detail: "requires a preview URL",
    });
  }

  const generatedId =
    input.action.id ??
    nextProjectScriptId(
      name,
      input.scripts.map((script) => script.id),
    );
  const id = validateActionId(generatedId);
  if (typeof id !== "string") return id;
  if (input.scripts.some((script) => script.id === id)) {
    return new ProjectActionAlreadyExistsError({ projectId: input.projectId, actionId: id });
  }

  const action = buildProjectScript(id, {
    name,
    command,
    icon: input.action.icon,
    runOnWorktreeCreate: input.action.runOnWorktreeCreate,
    previewUrl,
    autoOpenPreview: input.action.autoOpenPreview,
  });
  const normalized = normalizeProjectSetupScript([...input.scripts, action], action.id);
  return {
    action,
    scripts: normalized.scripts,
    clearedRunOnWorktreeCreate: normalized.clearedActionIds,
  };
}

export function updateProjectAction(input: {
  readonly projectId: ProjectId;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly actionId: string;
  readonly updates: UpdateProjectActionInput;
}): ProjectActionMutationResult | ProjectActionNotFoundError | ProjectActionValidationError {
  const current = findAction(input.projectId, input.scripts, input.actionId);
  if ("_tag" in current) return current;

  const name =
    input.updates.name === undefined ? current.name : requiredTrimmed("name", input.updates.name);
  if (typeof name !== "string") return name;
  const command =
    input.updates.command === undefined
      ? current.command
      : requiredTrimmed("command", input.updates.command);
  if (typeof command !== "string") return command;

  const previewUrl =
    input.updates.previewUrl === undefined
      ? (current.previewUrl ?? null)
      : input.updates.previewUrl === null
        ? null
        : optionalPreviewUrl(input.updates.previewUrl);
  if (previewUrl !== null && typeof previewUrl !== "string") return previewUrl;
  const autoOpenPreview =
    previewUrl === null
      ? false
      : (input.updates.autoOpenPreview ?? current.autoOpenPreview ?? false);
  if (input.updates.autoOpenPreview === true && previewUrl === null) {
    return new ProjectActionValidationError({
      field: "autoOpenPreview",
      detail: "requires a preview URL",
    });
  }

  const action = buildProjectScript(current.id, {
    name,
    command,
    icon: input.updates.icon ?? current.icon,
    runOnWorktreeCreate: input.updates.runOnWorktreeCreate ?? current.runOnWorktreeCreate,
    previewUrl,
    autoOpenPreview,
  });
  const nextScripts = input.scripts.map((candidate) =>
    candidate.id === action.id ? action : candidate,
  );
  const normalized = normalizeProjectSetupScript(nextScripts, action.id);
  return {
    action,
    scripts: normalized.scripts,
    clearedRunOnWorktreeCreate: normalized.clearedActionIds,
  };
}

export function removeProjectAction(input: {
  readonly projectId: ProjectId;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly actionId: string;
}):
  | { readonly action: ProjectScript; readonly scripts: ReadonlyArray<ProjectScript> }
  | ProjectActionNotFoundError {
  const action = findAction(input.projectId, input.scripts, input.actionId);
  if ("_tag" in action) return action;
  return {
    action,
    scripts: input.scripts.filter((candidate) => candidate.id !== action.id),
  };
}
