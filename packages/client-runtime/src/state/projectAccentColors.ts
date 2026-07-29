/**
 * Project accent colors, shared by every client.
 *
 * Accents live in each server's `ServerSettings.projectAccentColors` rather
 * than in client-local settings, so a color picked in the desktop sidebar
 * shows up in the mobile thread list and on every other machine. That storage
 * choice drives the three rules in this module:
 *
 * - **Keys are machine-independent** (`deriveProjectAccentKey`). The map is
 *   persisted per environment, so a key containing an environmentId would be
 *   meaningless to every other client reading it. Git projects key by the
 *   repository canonical key — every worktree and checkout of a repo shares
 *   one color, which is the intended behavior — and non-git projects fall
 *   back to the normalized workspace path.
 * - **Reads merge across environments** (`resolveProjectAccentColor`).
 *   Project-owning environments win; other connected environments only fill
 *   gaps. Both tiers use the same stable ordering on every client.
 * - **Writes fan out** (`buildProjectAccentColorPatches`). Picking a color
 *   patches every connected environment that owns a member of the group, so
 *   the color becomes durable on each machine rather than on whichever one
 *   happened to be primary.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { SidebarProjectAccentColor } from "@t3tools/contracts/settings";

import type { EnvironmentProject } from "./models.ts";
import { normalizeProjectPathForComparison } from "./projects.ts";

export type ProjectAccentColorMap = Readonly<Record<string, SidebarProjectAccentColor>>;

/** The minimum a project needs to expose to take part in accent resolution. */
export type ProjectAccentSource = Pick<
  EnvironmentProject,
  "environmentId" | "workspaceRoot" | "repositoryIdentity"
>;

/** One member of a project group, reduced to what accent resolution needs. */
export interface ProjectAccentMember {
  readonly environmentId: EnvironmentId;
  readonly accentKey: string;
}

/**
 * The machine-independent key a project's accent is stored under.
 *
 * Returns null for a project we cannot key stably (no repository identity and
 * an empty workspace root); such a project simply has no accent.
 */
export function deriveProjectAccentKey(project: ProjectAccentSource): string | null {
  const canonicalKey = project.repositoryIdentity?.canonicalKey?.trim();
  if (canonicalKey) {
    return canonicalKey;
  }

  // Deliberately WITHOUT the environment prefix `derivePhysicalProjectKey`
  // adds: the same path on two machines is the closest thing to a shared
  // identity a non-git project has.
  const normalizedPath = normalizeProjectPathForComparison(project.workspaceRoot);
  return normalizedPath.length > 0 ? normalizedPath : null;
}

export function toProjectAccentMember(project: ProjectAccentSource): ProjectAccentMember | null {
  const accentKey = deriveProjectAccentKey(project);
  return accentKey === null ? null : { environmentId: project.environmentId, accentKey };
}

export function toProjectAccentMembers(
  projects: ReadonlyArray<ProjectAccentSource>,
): ProjectAccentMember[] {
  return projects.flatMap((project) => {
    const member = toProjectAccentMember(project);
    return member === null ? [] : [member];
  });
}

function orderEnvironmentIds(environmentIds: Iterable<EnvironmentId>): EnvironmentId[] {
  return [...new Set(environmentIds)].toSorted((left, right) => left.localeCompare(right));
}

function orderMembers(members: ReadonlyArray<ProjectAccentMember>): ProjectAccentMember[] {
  return [...members].toSorted(
    (left, right) =>
      left.environmentId.localeCompare(right.environmentId) ||
      left.accentKey.localeCompare(right.accentKey),
  );
}

export interface ResolveProjectAccentColorInput {
  /** Every project in the group, across environments. */
  readonly members: ReadonlyArray<ProjectAccentMember>;
  /** Accent maps of the currently connected environments. */
  readonly accentColorsByEnvironment: ReadonlyMap<EnvironmentId, ProjectAccentColorMap>;
}

/**
 * A group's accent: the entry stored by one of the group's OWN environments
 * if any has one, otherwise any other connected environment's entry for the
 * same key. The fallback only fills gaps — an environment's own explicit
 * entry is never overridden by another environment's.
 */
export function resolveProjectAccentColor(
  input: ResolveProjectAccentColorInput,
): SidebarProjectAccentColor | null {
  for (const member of orderMembers(input.members)) {
    const color = input.accentColorsByEnvironment.get(member.environmentId)?.[member.accentKey];
    if (color !== undefined) return color;
  }

  const accentKeys = [...new Set(input.members.map((member) => member.accentKey))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  if (accentKeys.length === 0) return null;

  for (const environmentId of orderEnvironmentIds(input.accentColorsByEnvironment.keys())) {
    const accentColors = input.accentColorsByEnvironment.get(environmentId);
    if (accentColors === undefined) continue;
    for (const accentKey of accentKeys) {
      const color = accentColors[accentKey];
      if (color !== undefined) return color;
    }
  }

  return null;
}

export interface ProjectAccentColorPatch {
  readonly environmentId: EnvironmentId;
  readonly projectAccentColors: Record<string, SidebarProjectAccentColor>;
}

export function collectWritableProjectAccentKeys(input: {
  readonly members: ReadonlyArray<ProjectAccentMember>;
  readonly accentColorsByEnvironment: ReadonlyMap<EnvironmentId, ProjectAccentColorMap>;
  readonly writableEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ReadonlyMap<EnvironmentId, ReadonlySet<string>> {
  const accentKeysByEnvironment = new Map<EnvironmentId, Set<string>>();
  for (const member of input.members) {
    if (
      !input.writableEnvironmentIds.has(member.environmentId) ||
      !input.accentColorsByEnvironment.has(member.environmentId)
    ) {
      continue;
    }
    const accentKeys = accentKeysByEnvironment.get(member.environmentId);
    if (accentKeys) accentKeys.add(member.accentKey);
    else accentKeysByEnvironment.set(member.environmentId, new Set([member.accentKey]));
  }
  return accentKeysByEnvironment;
}

export function withProjectAccentKeys(
  accentColors: ProjectAccentColorMap,
  accentKeys: ReadonlySet<string>,
  color: SidebarProjectAccentColor | null,
): { readonly next: Record<string, SidebarProjectAccentColor>; readonly changed: boolean } {
  const next = { ...accentColors };
  let changed = false;
  for (const accentKey of accentKeys) {
    if (color === null) {
      if (accentKey in next) {
        delete next[accentKey];
        changed = true;
      }
    } else if (next[accentKey] !== color) {
      next[accentKey] = color;
      changed = true;
    }
  }
  return { next, changed };
}

/**
 * The per-environment patches that set (or clear) a group's accent. One patch
 * per connected environment owning a member — that is what makes the color
 * durable on each machine instead of only on whichever server the picker
 * happened to be pointed at. Unchanged environments are omitted.
 */
export function buildProjectAccentColorPatches(input: {
  readonly members: ReadonlyArray<ProjectAccentMember>;
  readonly accentColorsByEnvironment: ReadonlyMap<EnvironmentId, ProjectAccentColorMap>;
  /** Connected environments that advertise accent-setting persistence. */
  readonly writableEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly color: SidebarProjectAccentColor | null;
}): ProjectAccentColorPatch[] {
  const accentKeysByEnvironment = collectWritableProjectAccentKeys(input);

  return [...accentKeysByEnvironment].flatMap(([environmentId, accentKeys]) => {
    const { next, changed } = withProjectAccentKeys(
      input.accentColorsByEnvironment.get(environmentId) ?? {},
      accentKeys,
      input.color,
    );
    return changed ? [{ environmentId, projectAccentColors: next }] : [];
  });
}

// ── Legacy client-settings migration ─────────────────────────────────

export interface ProjectAccentColorMigrationPlan {
  /**
   * One write per environment. Legacy keys are attached to their write so the
   * caller consumes them only after that server acknowledges persistence.
   */
  readonly patches: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectAccentColorsFill: Record<string, SidebarProjectAccentColor>;
    readonly migrations: ReadonlyArray<{
      readonly legacyKey: string;
      readonly accentKey: string;
      readonly color: SidebarProjectAccentColor;
    }>;
  }>;
  /** Legacy keys whose live server map already has an authoritative color. */
  readonly consumedWithoutWrite: ReadonlyArray<string>;
}

/**
 * Plans the one-shot migration of pre-server accent entries.
 *
 * Legacy entries live in `ClientSettings.sidebarProjectAccentColors`, keyed
 * `${environmentId}:${normalizedWorkspacePath}`. Each one is translated into
 * its project's environment server settings under the machine-independent
 * key. The caller consumes entries only after their write succeeds. An entry
 * whose target already has a new-style color needs no write and is safe to
 * consume immediately — the server map is authoritative once populated.
 */
export function planProjectAccentColorMigration(input: {
  readonly clientAccentColors: ProjectAccentColorMap;
  readonly projects: ReadonlyArray<ProjectAccentSource>;
  readonly accentColorsByEnvironment: ReadonlyMap<EnvironmentId, ProjectAccentColorMap>;
  /** Connected environments that advertise atomic fill-if-absent persistence. */
  readonly fillCapableEnvironmentIds: ReadonlySet<EnvironmentId>;
  /** Builds the legacy `${environmentId}:${normalizedPath}` key. */
  readonly deriveLegacyKey: (project: ProjectAccentSource) => string;
}): ProjectAccentColorMigrationPlan {
  const legacyEntries = Object.entries(input.clientAccentColors);
  if (legacyEntries.length === 0) {
    return { patches: [], consumedWithoutWrite: [] };
  }

  const projectsByLegacyKey = new Map<string, ProjectAccentSource>();
  for (const project of input.projects) {
    const legacyKey = input.deriveLegacyKey(project);
    if (!projectsByLegacyKey.has(legacyKey)) projectsByLegacyKey.set(legacyKey, project);
  }

  const fillByEnvironment = new Map<EnvironmentId, Record<string, SidebarProjectAccentColor>>();
  const migrationsByEnvironment = new Map<
    EnvironmentId,
    Array<{
      readonly legacyKey: string;
      readonly accentKey: string;
      readonly color: SidebarProjectAccentColor;
    }>
  >();
  const consumedWithoutWrite: string[] = [];

  for (const [legacyKey, color] of legacyEntries) {
    const project = projectsByLegacyKey.get(legacyKey);
    if (project === undefined) continue;

    const environmentAccentColors = input.accentColorsByEnvironment.get(project.environmentId);
    if (
      environmentAccentColors === undefined ||
      !input.fillCapableEnvironmentIds.has(project.environmentId)
    ) {
      continue;
    }

    const accentKey = deriveProjectAccentKey(project);
    if (accentKey === null) continue;

    if (environmentAccentColors[accentKey] !== undefined) {
      consumedWithoutWrite.push(legacyKey);
      continue;
    }

    const fill = fillByEnvironment.get(project.environmentId) ?? {};
    fillByEnvironment.set(project.environmentId, fill);
    if (fill[accentKey] === undefined) {
      fill[accentKey] = color;
    }
    const migrations = migrationsByEnvironment.get(project.environmentId);
    const migration = { legacyKey, accentKey, color };
    if (migrations) migrations.push(migration);
    else migrationsByEnvironment.set(project.environmentId, [migration]);
  }

  return {
    patches: [...migrationsByEnvironment].map(([environmentId, migrations]) => ({
      environmentId,
      projectAccentColorsFill: fillByEnvironment.get(environmentId) ?? {},
      migrations,
    })),
    consumedWithoutWrite,
  };
}
