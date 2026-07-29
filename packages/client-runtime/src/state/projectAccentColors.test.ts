import type { EnvironmentId, RepositoryIdentity } from "@t3tools/contracts";
import type { SidebarProjectAccentColor } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectAccentColorPatches,
  deriveProjectAccentKey,
  planProjectAccentColorMigration,
  resolveProjectAccentColor,
  toProjectAccentMembers,
  type ProjectAccentColorMap,
  type ProjectAccentSource,
} from "./projectAccentColors.ts";
import { derivePhysicalProjectKey } from "./projectGrouping.ts";

const environmentId = (value: string): EnvironmentId => value as EnvironmentId;
const color = (value: string): SidebarProjectAccentColor => value as SidebarProjectAccentColor;

const LOCAL = environmentId("environment-local");
const REMOTE = environmentId("environment-remote");
const THIRD = environmentId("environment-third");

function repositoryIdentity(canonicalKey: string): RepositoryIdentity {
  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://${canonicalKey}.git`,
    },
  };
}

function project(input: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly canonicalKey?: string;
}): ProjectAccentSource {
  return {
    environmentId: input.environmentId,
    workspaceRoot: input.workspaceRoot,
    repositoryIdentity:
      input.canonicalKey === undefined ? null : repositoryIdentity(input.canonicalKey),
  };
}

function accentMaps(
  entries: ReadonlyArray<readonly [EnvironmentId, Record<string, string>]>,
): ReadonlyMap<EnvironmentId, ProjectAccentColorMap> {
  return new Map(
    entries.map(([id, map]) => [id, map as Record<string, SidebarProjectAccentColor>] as const),
  );
}

describe("deriveProjectAccentKey", () => {
  it("keys a git project by its repository canonical key, not its path", () => {
    const worktree = project({
      environmentId: LOCAL,
      workspaceRoot: "/work/t3code-worktrees/feature",
      canonicalKey: "github.com/t3tools/t3code",
    });
    const checkout = project({
      environmentId: REMOTE,
      workspaceRoot: "/Users/someone/repos/t3code",
      canonicalKey: "github.com/t3tools/t3code",
    });

    expect(deriveProjectAccentKey(worktree)).toBe("github.com/t3tools/t3code");
    // Every worktree/checkout of a repo intentionally shares one accent.
    expect(deriveProjectAccentKey(checkout)).toBe(deriveProjectAccentKey(worktree));
  });

  it("falls back to the normalized path, WITHOUT an environment prefix", () => {
    const key = deriveProjectAccentKey(
      project({ environmentId: LOCAL, workspaceRoot: "/work/scratch/" }),
    );

    expect(key).toBe("/work/scratch");
    expect(key).not.toContain(LOCAL);
  });

  it("has no key for a project with neither identity nor path", () => {
    expect(
      deriveProjectAccentKey(project({ environmentId: LOCAL, workspaceRoot: "  " })),
    ).toBeNull();
    expect(toProjectAccentMembers([project({ environmentId: LOCAL, workspaceRoot: "" })])).toEqual(
      [],
    );
  });
});

describe("resolveProjectAccentColor", () => {
  const members = toProjectAccentMembers([
    project({ environmentId: LOCAL, workspaceRoot: "/work/a", canonicalKey: "repo/a" }),
    project({ environmentId: REMOTE, workspaceRoot: "/srv/a", canonicalKey: "repo/a" }),
  ]);

  it("orders conflicting member environments deterministically", () => {
    const maps = accentMaps([
      [LOCAL, { "repo/a": "#111111" }],
      [REMOTE, { "repo/a": "#222222" }],
    ]);

    expect(resolveProjectAccentColor({ members, accentColorsByEnvironment: maps })).toBe("#111111");
    expect(
      resolveProjectAccentColor({
        members,
        accentColorsByEnvironment: accentMaps([
          [REMOTE, { "repo/a": "#222222" }],
          [LOCAL, { "repo/a": "#111111" }],
        ]),
      }),
    ).toBe("#111111");
  });

  it("never lets another environment override an environment's own entry", () => {
    const maps = accentMaps([
      [REMOTE, { "repo/a": "#222222" }],
      [THIRD, { "repo/a": "#333333" }],
    ]);
    const remoteMember = toProjectAccentMembers([
      project({ environmentId: REMOTE, workspaceRoot: "/srv/a", canonicalKey: "repo/a" }),
    ]);

    expect(
      resolveProjectAccentColor({
        members: remoteMember,
        accentColorsByEnvironment: maps,
      }),
    ).toBe("#222222");
  });

  it("fills a gap from another connected environment holding the same key", () => {
    const maps = accentMaps([
      [LOCAL, {}],
      [REMOTE, { "repo/a": "#333333" }],
    ]);

    expect(resolveProjectAccentColor({ members, accentColorsByEnvironment: maps })).toBe("#333333");
  });

  it("orders the cross-environment fallback deterministically", () => {
    // Only the third environment is in the group; the other two are merely
    // connected and both hold the key, so the tie-break must be stable.
    const soloMembers = toProjectAccentMembers([
      project({ environmentId: THIRD, workspaceRoot: "/x/a", canonicalKey: "repo/a" }),
    ]);
    const maps = accentMaps([
      [REMOTE, { "repo/a": "#aaaaaa" }],
      [LOCAL, { "repo/a": "#bbbbbb" }],
      [THIRD, {}],
    ]);

    // environment-local < environment-remote alphabetically, regardless of
    // map insertion order or which client is rendering.
    expect(
      resolveProjectAccentColor({ members: soloMembers, accentColorsByEnvironment: maps }),
    ).toBe("#bbbbbb");
    expect(
      resolveProjectAccentColor({
        members: soloMembers,
        accentColorsByEnvironment: accentMaps([
          [THIRD, {}],
          [LOCAL, { "repo/a": "#bbbbbb" }],
          [REMOTE, { "repo/a": "#aaaaaa" }],
        ]),
      }),
    ).toBe("#bbbbbb");
  });

  it("returns null when nothing anywhere holds the key", () => {
    expect(
      resolveProjectAccentColor({
        members,
        accentColorsByEnvironment: accentMaps([[LOCAL, { "repo/other": "#cccccc" }]]),
      }),
    ).toBeNull();
    expect(
      resolveProjectAccentColor({ members: [], accentColorsByEnvironment: accentMaps([]) }),
    ).toBeNull();
  });
});

describe("buildProjectAccentColorPatches", () => {
  const members = toProjectAccentMembers([
    project({ environmentId: LOCAL, workspaceRoot: "/work/a", canonicalKey: "repo/a" }),
    project({ environmentId: REMOTE, workspaceRoot: "/srv/a", canonicalKey: "repo/a" }),
  ]);

  it("fans one pick out to every connected member environment", () => {
    const patches = buildProjectAccentColorPatches({
      members,
      accentColorsByEnvironment: accentMaps([
        [LOCAL, { "repo/other": "#cccccc" }],
        [REMOTE, {}],
      ]),
      writableEnvironmentIds: new Set([LOCAL, REMOTE]),
      color: color("#0055aa"),
    });

    expect(patches).toEqual([
      {
        environmentId: LOCAL,
        projectAccentColors: { "repo/other": "#cccccc", "repo/a": "#0055aa" },
      },
      { environmentId: REMOTE, projectAccentColors: { "repo/a": "#0055aa" } },
    ]);
  });

  it("clears the key on every member environment", () => {
    expect(
      buildProjectAccentColorPatches({
        members,
        accentColorsByEnvironment: accentMaps([
          [LOCAL, { "repo/a": "#0055aa", "repo/other": "#cccccc" }],
          [REMOTE, { "repo/a": "#0055aa" }],
        ]),
        writableEnvironmentIds: new Set([LOCAL, REMOTE]),
        color: null,
      }),
    ).toEqual([
      { environmentId: LOCAL, projectAccentColors: { "repo/other": "#cccccc" } },
      { environmentId: REMOTE, projectAccentColors: {} },
    ]);
  });

  it("skips unchanged and disconnected environments", () => {
    // REMOTE is not connected: a blind whole-map write would wipe its state.
    expect(
      buildProjectAccentColorPatches({
        members,
        accentColorsByEnvironment: accentMaps([
          [LOCAL, { "repo/a": "#0055aa" }],
          [REMOTE, { "repo/a": "#ff0000" }],
        ]),
        writableEnvironmentIds: new Set([LOCAL]),
        color: color("#0055aa"),
      }),
    ).toEqual([]);
  });
});

describe("planProjectAccentColorMigration", () => {
  const localProject = project({
    environmentId: LOCAL,
    workspaceRoot: "/work/a",
    canonicalKey: "repo/a",
  });
  const remoteProject = project({ environmentId: REMOTE, workspaceRoot: "/srv/b" });
  const legacyLocalKey = derivePhysicalProjectKey({
    environmentId: LOCAL,
    workspaceRoot: "/work/a",
  });
  const legacyRemoteKey = derivePhysicalProjectKey({
    environmentId: REMOTE,
    workspaceRoot: "/srv/b",
  });

  const plan = (input: {
    readonly clientAccentColors: Record<string, string>;
    readonly accentColorsByEnvironment: ReadonlyMap<EnvironmentId, ProjectAccentColorMap>;
    readonly fillCapableEnvironmentIds?: ReadonlySet<EnvironmentId>;
  }) =>
    planProjectAccentColorMigration({
      clientAccentColors: input.clientAccentColors as Record<string, SidebarProjectAccentColor>,
      projects: [localProject, remoteProject],
      accentColorsByEnvironment: input.accentColorsByEnvironment,
      fillCapableEnvironmentIds:
        input.fillCapableEnvironmentIds ?? new Set(input.accentColorsByEnvironment.keys()),
      deriveLegacyKey: derivePhysicalProjectKey,
    });

  it("translates legacy entries onto the machine-independent key", () => {
    const result = plan({
      clientAccentColors: { [legacyLocalKey]: "#0055aa", [legacyRemoteKey]: "#00aa55" },
      accentColorsByEnvironment: accentMaps([
        [LOCAL, {}],
        [REMOTE, {}],
      ]),
    });

    expect(result.patches).toEqual([
      {
        environmentId: LOCAL,
        projectAccentColorsFill: { "repo/a": "#0055aa" },
        migrations: [{ legacyKey: legacyLocalKey, accentKey: "repo/a", color: "#0055aa" }],
      },
      {
        environmentId: REMOTE,
        projectAccentColorsFill: { "/srv/b": "#00aa55" },
        migrations: [{ legacyKey: legacyRemoteKey, accentKey: "/srv/b", color: "#00aa55" }],
      },
    ]);
    expect(result.consumedWithoutWrite).toEqual([]);
  });

  it("is idempotent once the server holds the migrated state", () => {
    const second = plan({
      clientAccentColors: { [legacyLocalKey]: "#0055aa" },
      accentColorsByEnvironment: accentMaps([[LOCAL, { "repo/a": "#0055aa" }]]),
    });

    expect(second.patches).toEqual([]);
    expect(second.consumedWithoutWrite).toEqual([legacyLocalKey]);
  });

  it("consumes but never overwrites an existing server-side accent", () => {
    const result = plan({
      clientAccentColors: { [legacyLocalKey]: "#0055aa" },
      accentColorsByEnvironment: accentMaps([[LOCAL, { "repo/a": "#ff0000" }]]),
    });

    expect(result.patches).toEqual([]);
    expect(result.consumedWithoutWrite).toEqual([legacyLocalKey]);
  });

  it("keeps entries whose environment or project is not available yet", () => {
    const result = plan({
      clientAccentColors: {
        [legacyLocalKey]: "#0055aa",
        [legacyRemoteKey]: "#00aa55",
        "environment-unknown:/gone": "#123456",
      },
      accentColorsByEnvironment: accentMaps([[LOCAL, {}]]),
    });

    expect(result.patches).toEqual([
      {
        environmentId: LOCAL,
        projectAccentColorsFill: { "repo/a": "#0055aa" },
        migrations: [{ legacyKey: legacyLocalKey, accentKey: "repo/a", color: "#0055aa" }],
      },
    ]);
    expect(result.consumedWithoutWrite).toEqual([]);
  });

  it("does nothing when there is nothing to migrate", () => {
    expect(plan({ clientAccentColors: {}, accentColorsByEnvironment: accentMaps([]) })).toEqual({
      patches: [],
      consumedWithoutWrite: [],
    });
  });

  it("does not migrate without the atomic fill capability", () => {
    expect(
      plan({
        clientAccentColors: { [legacyLocalKey]: "#0055aa" },
        accentColorsByEnvironment: accentMaps([[LOCAL, {}]]),
        fillCapableEnvironmentIds: new Set(),
      }),
    ).toEqual({ patches: [], consumedWithoutWrite: [] });
  });
});
