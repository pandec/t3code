import { expect, it } from "@effect/vitest";
import {
  type Project,
  ProjectId,
  type ProjectScript,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as ProjectActions from "./ProjectActions.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("project-actions");
const setup: ProjectScript = {
  id: "setup",
  name: "Setup",
  command: "pnpm install",
  icon: "configure",
  runOnWorktreeCreate: true,
  async: false,
};
const dev: ProjectScript = {
  id: "dev",
  name: "Dev",
  command: "pnpm dev",
  icon: "play",
  runOnWorktreeCreate: false,
  previewUrl: "http://localhost:5173",
  autoOpenPreview: true,
};

const projectLayer = Layer.mock(ProjectService.ProjectService)({
  getById: (id) =>
    Effect.succeed(
      id === projectId
        ? Option.some({
            id: projectId,
            title: "Actions",
            workspaceRoot: "/repo",
            scripts: [],
          } as unknown as Project)
        : Option.none(),
    ),
});

/** Environment defaults hold the actions, so the project starts out inheriting them. */
const settingsLayer = ServerSettings.layerTest({
  projectSettingsFolded: true,
  defaultProjectScripts: [setup, dev],
});

const makeLayer = (
  settings: Layer.Layer<ServerSettings.ServerSettingsService, ServerSettingsError> = settingsLayer,
) => ProjectActions.layer.pipe(Layer.provideMerge(settings), Layer.provide(projectLayer));

const service = ProjectActions.ProjectActions;

it.effect("creates an action with a collision-safe id as a project override", () =>
  Effect.gen(function* () {
    const actions = yield* service;
    const result = yield* actions.upsert({ projectId, name: " Dev ", command: "pnpm dev:web" });
    expect(result).toEqual({
      projectId,
      action: "created",
      projectAction: {
        id: "dev-2",
        name: "Dev",
        command: "pnpm dev:web",
        icon: "play",
        runOnWorktreeCreate: false,
      },
      clearedRunOnWorktreeCreate: [],
    });
    expect((yield* actions.list(projectId)).actions.map((action) => action.id)).toEqual([
      "setup",
      "dev",
      "dev-2",
    ]);
    // The environment defaults stay as they were.
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
    expect(settings.defaultProjectScripts).toEqual([setup, dev]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("updates preserve omitted fields and null clears the preview", () =>
  Effect.gen(function* () {
    const actions = yield* service;
    const renamed = yield* actions.upsert({ projectId, actionId: "setup", name: "Install" });
    expect(renamed.projectAction).toEqual({ ...setup, name: "Install" });
    const cleared = yield* actions.upsert({ projectId, actionId: "dev", previewUrl: null });
    expect(cleared.projectAction).toEqual({
      id: "dev",
      name: "Dev",
      command: "pnpm dev",
      icon: "play",
      runOnWorktreeCreate: false,
    });
    const failure = yield* actions
      .upsert({ projectId, actionId: "dev", autoOpenPreview: true })
      .pipe(Effect.flip);
    expect(failure).toBeInstanceOf(ProjectActions.ProjectActionValidationError);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps a single worktree setup action and reports the cleared one", () =>
  Effect.gen(function* () {
    const actions = yield* service;
    const result = yield* actions.upsert({ projectId, actionId: "dev", runOnWorktreeCreate: true });
    expect(result.clearedRunOnWorktreeCreate).toEqual(["setup"]);
    const listed = (yield* actions.list(projectId)).actions;
    expect(
      listed.filter((action) => action.runOnWorktreeCreate).map((action) => action.id),
    ).toEqual(["dev"]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("removes an action and reports unknown ids", () =>
  Effect.gen(function* () {
    const actions = yield* service;
    expect(yield* actions.remove({ projectId, actionId: "dev" })).toEqual({
      projectId,
      action: "removed",
      actionId: "dev",
    });
    expect((yield* actions.list(projectId)).actions).toEqual([setup]);
    const missing = yield* actions.remove({ projectId, actionId: "dev" }).pipe(Effect.flip);
    expect(missing).toBeInstanceOf(ProjectActions.ProjectActionNotFoundError);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("reports a conflict when another client changed the actions meanwhile", () => {
  // Another client edits the actions right after this service reads them.
  const racing = Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const real = yield* ServerSettings.ServerSettingsService;
      return ServerSettings.ServerSettingsService.of({
        ...real,
        getSettings: real.getSettings.pipe(
          Effect.tap((current) =>
            real.updateSettings({
              projectScriptUpdate: {
                projectId,
                expectedScripts: [...current.defaultProjectScripts],
                scripts: [setup],
              },
            }),
          ),
        ),
      });
    }),
  ).pipe(Layer.provide(settingsLayer));
  return Effect.gen(function* () {
    const actions = yield* service;
    const failure = yield* actions.remove({ projectId, actionId: "dev" }).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(ProjectActions.ProjectActionsConflictError);
  }).pipe(Effect.provide(makeLayer(racing)));
});
