import { assert, describe, it, vi } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

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

function makeInstance(listSkills: ProviderInstance["adapter"]["listSkills"]): ProviderInstance {
  return {
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
    },
    adapter: { listSkills } as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
}

describe("listProviderSkillsForCwd", () => {
  it.effect("passes the active workspace cwd to the provider adapter", () =>
    Effect.gen(function* () {
      const listSkills = vi.fn(({ cwd }: { readonly cwd: string }) =>
        Effect.succeed(cwd === "/workspace" ? [snapshotSkill, projectSkill] : []),
      );
      const registry = {
        getInstance: () => Effect.succeed(makeInstance(listSkills)),
      };

      const result = yield* listProviderSkillsForCwd(registry, {
        instanceId,
        cwd: "/workspace",
      });

      assert.deepEqual(result.skills, [snapshotSkill, projectSkill]);
      assert.deepEqual(listSkills.mock.calls, [[{ cwd: "/workspace" }]]);
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

      const result = yield* listProviderSkillsForCwd(registry, {
        instanceId,
        cwd: "/workspace",
      });

      assert.deepEqual(result.skills, [snapshotSkill]);
    }),
  );
});
