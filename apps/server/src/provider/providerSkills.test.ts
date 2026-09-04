import { assert, describe, it, vi } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { ProviderInstance } from "./ProviderDriver.ts";
import { ProviderAdapterRequestError } from "./Errors.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { listProviderSkillsForCwd } from "./providerSkills.ts";

const instanceId = ProviderInstanceId.make("codex");
const snapshotSkill: ServerProviderSkill = {
  name: "global-skill",
  path: "/home/.agents/skills/global-skill/SKILL.md",
  scope: "user",
  enabled: true,
};
const projectSkill: ServerProviderSkill = {
  name: "project-skill",
  path: "/workspace/.agents/skills/project-skill/SKILL.md",
  scope: "repo",
  enabled: true,
};
const snapshot: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-07-20T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [snapshotSkill],
};

function makeInstance(
  listSkills: ProviderInstance["adapter"]["listSkills"],
  listSkillsTimeoutMillis?: number,
  snapshotForCwd?: ProviderInstance["snapshotForCwd"],
): ProviderInstance {
  return {
    ...(snapshotForCwd === undefined ? {} : { snapshotForCwd }),
    instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("codex"),
      continuationKey: "codex",
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
        provider: ProviderDriverKind.make("codex"),
        packageName: "@openai/codex",
      }),
      getSnapshot: Effect.succeed(snapshot),
      refresh: Effect.succeed(snapshot),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    adapter: {
      listSkills,
      ...(listSkillsTimeoutMillis === undefined ? {} : { listSkillsTimeoutMillis }),
    } as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
}

const inertProviderRegistry = {
  refreshWorkspaceSnapshot: () => Effect.succeed<ReadonlyArray<ServerProvider>>([]),
};

describe("listProviderSkillsForCwd", () => {
  it.effect("passes the active workspace cwd to the provider adapter", () =>
    Effect.gen(function* () {
      const listSkills = vi.fn(({ cwd }: { readonly cwd: string }) =>
        Effect.succeed(cwd === "/workspace" ? [snapshotSkill, projectSkill] : []),
      );
      const registry = {
        getInstance: () => Effect.succeed(makeInstance(listSkills)),
      };

      const result = yield* listProviderSkillsForCwd(registry, inertProviderRegistry, {
        instanceId,
        cwd: "/workspace",
      });

      assert.deepEqual(result.skills, [snapshotSkill, projectSkill]);
      assert.deepEqual(listSkills.mock.calls, [[{ cwd: "/workspace" }]]);
    }),
  );

  it.effect("prefers adapter skills when both workspace discovery hooks exist", () =>
    Effect.gen(function* () {
      const listSkills = vi.fn(() => Effect.succeed<ReadonlyArray<ServerProviderSkill>>([]));
      const refreshWorkspaceSnapshot = vi.fn(() =>
        Effect.succeed<ReadonlyArray<ServerProvider>>([snapshot]),
      );
      const registry = {
        getInstance: () =>
          Effect.succeed(
            makeInstance(listSkills, undefined, () => Effect.die("probed outside the registry")),
          ),
      };

      const result = yield* listProviderSkillsForCwd(
        registry,
        { refreshWorkspaceSnapshot },
        { instanceId, cwd: "/workspace" },
      );

      assert.deepEqual(result.skills, []);
      assert.deepEqual(listSkills.mock.calls, [[{ cwd: "/workspace" }]]);
      assert.equal(refreshWorkspaceSnapshot.mock.calls.length, 0);
    }),
  );

  it.effect("falls back to snapshot skills when workspace discovery fails", () =>
    Effect.gen(function* () {
      const registry = {
        getInstance: () =>
          Effect.succeed(
            makeInstance(() =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "skills/list",
                  detail: "skills unavailable",
                }),
              ),
            ),
          ),
      };

      const result = yield* listProviderSkillsForCwd(registry, inertProviderRegistry, {
        instanceId,
        cwd: "/workspace",
      });

      assert.deepEqual(result.skills, [snapshotSkill]);
    }),
  );

  it.effect("falls back to the workspace snapshot when adapter discovery fails", () =>
    Effect.gen(function* () {
      const listSkills = vi.fn(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "claudeAgent",
            method: "skills/list",
            detail: "skills unavailable",
          }),
        ),
      );
      const refreshWorkspaceSnapshot = vi.fn(() =>
        Effect.succeed<ReadonlyArray<ServerProvider>>([
          {
            ...snapshot,
            workspaceSnapshots: [
              {
                cwd: "/workspace",
                checkedAt: "2026-07-20T00:00:00.000Z",
                slashCommands: [],
                skills: [projectSkill],
              },
            ],
          },
        ]),
      );
      const registry = {
        getInstance: () =>
          Effect.succeed(
            makeInstance(listSkills, undefined, () => Effect.die("probed outside the registry")),
          ),
      };

      const result = yield* listProviderSkillsForCwd(
        registry,
        { refreshWorkspaceSnapshot },
        { instanceId, cwd: "/workspace" },
      );

      assert.deepEqual(result.skills, [projectSkill]);
      assert.deepEqual(listSkills.mock.calls, [[{ cwd: "/workspace" }]]);
      assert.deepEqual(refreshWorkspaceSnapshot.mock.calls, [[{ instanceId, cwd: "/workspace" }]]);
    }),
  );

  it.effect("answers from the registry's workspace snapshot when the provider supports it", () =>
    Effect.gen(function* () {
      const refreshWorkspaceSnapshot = vi.fn(() =>
        Effect.succeed<ReadonlyArray<ServerProvider>>([
          {
            ...snapshot,
            workspaceSnapshots: [
              {
                cwd: "/workspace",
                checkedAt: "2026-07-20T00:00:00.000Z",
                slashCommands: [],
                skills: [projectSkill],
              },
            ],
          },
        ]),
      );
      const registry = {
        getInstance: () =>
          Effect.succeed(
            makeInstance(undefined, undefined, () => Effect.die("probed outside the registry")),
          ),
      };

      const result = yield* listProviderSkillsForCwd(
        registry,
        { refreshWorkspaceSnapshot },
        { instanceId, cwd: "/workspace" },
      );

      // The registry cache is the authority for this cwd, including when the
      // cached answer is empty.
      assert.deepEqual(result.skills, [projectSkill]);
      assert.deepEqual(refreshWorkspaceSnapshot.mock.calls, [[{ instanceId, cwd: "/workspace" }]]);
    }),
  );

  it.effect("falls back to machine skills when no workspace snapshot is available", () =>
    Effect.gen(function* () {
      const registry = {
        getInstance: () =>
          Effect.succeed(
            makeInstance(undefined, undefined, () => Effect.die("probed outside the registry")),
          ),
      };

      const result = yield* listProviderSkillsForCwd(
        registry,
        {
          refreshWorkspaceSnapshot: () => Effect.succeed<ReadonlyArray<ServerProvider>>([snapshot]),
        },
        { instanceId, cwd: "/workspace" },
      );

      assert.deepEqual(result.skills, [snapshotSkill]);
    }),
  );

  it.effect("honors a provider-specific skill discovery timeout", () =>
    Effect.gen(function* () {
      const registry = {
        getInstance: () =>
          Effect.succeed(
            makeInstance(() => Effect.sleep("15 seconds").pipe(Effect.as([projectSkill])), 20_000),
          ),
      };

      const fiber = yield* listProviderSkillsForCwd(registry, inertProviderRegistry, {
        instanceId,
        cwd: "/workspace",
      }).pipe(Effect.forkChild);

      yield* TestClock.adjust("15 seconds");
      const result = yield* Fiber.join(fiber);

      assert.deepEqual(result.skills, [projectSkill]);
    }),
  );
});
