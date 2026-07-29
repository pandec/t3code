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
 * - **Reads merge across environments** (`resolveProjectAccentColor`). A
 *   project's own environment wins; other connected environments only fill
 *   gaps, in a deterministic order so two clients never disagree.
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

/**
 * Deterministic environment order: the client's own/primary environment
 * first, then by id. Every client must walk fallbacks in the same order or
 * two clients looking at the same data would show different colors.
 */
function orderEnvironmentIds(
  environmentIds: Iterable<EnvironmentId>,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId[] {
  return [...new Set(environmentIds)].toSorted((left, right) => {
    if (left === primaryEnvironmentId) return right === primaryEnvironmentId ? 0 : -1;
    if (right === primaryEnvironmentId) return 1;
    return left.localeCompare(right);
  });
}

function orderMembers(
  members: ReadonlyArray<ProjectAccentMember>,
  primaryEnvironmentId: EnvironmentId | null,
  preferredEnvironmentId: EnvironmentId | null,
): ProjectAccentMember[] {
  const rank = (member: ProjectAccentMember): number =>
    member.environmentId === preferredEnvironmentId
      ? 0
      : member.environmentId === primaryEnvironmentId
        ? 1
        : 2;
  return [...members].toSorted(
    (left, right) =>
      rank(left) - rank(right) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.accentKey.localeCompare(right.accentKey),
  );
}

export interface ResolveProjectAccentColorInput {
  /** Every project in the group, across environments. */
  readonly members: ReadonlyArray<ProjectAccentMember>;
  /** Accent maps of the currently connected environments. */
  readonly accentColorsByEnvironment: ReadonlyMap<EnvironmentId, ProjectAccentColorMap>;
  /** The client's own environment, ranked first in every tie-break. */
  readonly primaryEnvironmentId?: EnvironmentId | null;
  /** The environment the caller is rendering for (a specific group member). */
  readonly preferredEnvironmentId?: EnvironmentId | null;
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
  const primaryEnvironmentId = input.primaryEnvironmentId ?? null;
  const preferredEnvironmentId = input.preferredEnvironmentId ?? null;

  for (const member of orderMembers(input.members, primaryEnvironmentId, preferredEnvironmentId)) {
    const color = input.accentColorsByEnvironment.get(member.environmentId)?.[member.accentKey];
    if (color !== undefined) return color;
  }

  const accentKeys = [...new Set(input.members.map((member) => member.accentKey))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  if (accentKeys.length === 0) return null;

  for (const environmentId of orderEnvironmentIds(
    input.accentColorsByEnvironment.keys(),
    primaryEnvironmentId,
  )) {
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

function withAccentKeys(
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
  readonly color: SidebarProjectAccentColor | null;
}): ProjectAccentColorPatch[] {
  const accentKeysByEnvironment = new Map<EnvironmentId, Set<string>>();
  for (const member of input.members) {
    // Environments that are not currently connected are skipped: we have no
    // map to patch, and writing a blind whole-map replacement would wipe
    // whatever that server actually holds.
    if (!input.accentColorsByEnvironment.has(member.environmentId)) continue;
    const accentKeys = accentKeysByEnvironment.get(member.environmentId);
    if (accentKeys) accentKeys.add(member.accentKey);
    else accentKeysByEnvironment.set(member.environmentId, new Set([member.accentKey]));
  }

  return [...accentKeysByEnvironment].flatMap(([environmentId, accentKeys]) => {
    const { next, changed } = withAccentKeys(
      input.accentColorsByEnvironment.get(environmentId) ?? {},
      accentKeys,
      input.color,
    );
    return changed ? [{ environmentId, projectAccentColors: next }] : [];
  });
}

// ── Legacy client-settings migration ─────────────────────────────────

export interface ProjectAccentColorMigrationPlan {
  readonly patches: ReadonlyArray<ProjectAccentColorPatch>;
  /**
   * The client map with every migrated entry removed, or null when nothing
   * changed. Entries whose environment is not currently connected (or whose
   * project is unknown) are kept so they can migrate the next time that
   * environment is seen.
   */
  readonly nextClientAccentColors: Record<string, SidebarProjectAccentColor> | null;
}

/**
 * Plans the one-shot migration of pre-server accent entries.
 *
 * Legacy entries live in `ClientSettings.sidebarProjectAccentColors`, keyed
 * `${environmentId}:${normalizedWorkspacePath}`. Each one is translated into
 * its project's environment server settings under the machine-independent
 * key. Idempotent: migrated entries are dropped from the client map, and an
 * entry whose target already has a new-style color is dropped WITHOUT
 * overwriting it — the server map is authoritative once populated.
 */
export function planProjectAccentColorMigration(input: {
  readonly clientAccentColors: ProjectAccentColorMap;
  readonly projects: ReadonlyArray<ProjectAccentSource>;
  readonly accentColorsByEnvironment: ReadonlyMap<EnvironmentId, ProjectAccentColorMap>;
  /** Builds the legacy `${environmentId}:${normalizedPath}` key. */
  readonly deriveLegacyKey: (project: ProjectAccentSource) => string;
}): ProjectAccentColorMigrationPlan {
  const legacyEntries = Object.entries(input.clientAccentColors);
  if (legacyEntries.length === 0) {
    return { patches: [], nextClientAccentColors: null };
  }

  const projectsByLegacyKey = new Map<string, ProjectAccentSource>();
  for (const project of input.projects) {
    const legacyKey = input.deriveLegacyKey(project);
    if (!projectsByLegacyKey.has(legacyKey)) projectsByLegacyKey.set(legacyKey, project);
  }

  const nextByEnvironment = new Map<EnvironmentId, Record<string, SidebarProjectAccentColor>>();
  const changedEnvironmentIds = new Set<EnvironmentId>();
  const migratedLegacyKeys = new Set<string>();

  for (const [legacyKey, color] of legacyEntries) {
    const project = projectsByLegacyKey.get(legacyKey);
    if (project === undefined) continue;

    const environmentAccentColors = input.accentColorsByEnvironment.get(project.environmentId);
    if (environmentAccentColors === undefined) continue;

    const accentKey = deriveProjectAccentKey(project);
    if (accentKey === null) continue;

    // The entry is consumed either way: an existing server-side color is the
    // user's newer, cross-machine choice and must not be clobbered.
    migratedLegacyKeys.add(legacyKey);
    const next =
      nextByEnvironment.get(project.environmentId) ??
      ({ ...environmentAccentColors } as Record<string, SidebarProjectAccentColor>);
    nextByEnvironment.set(project.environmentId, next);
    if (next[accentKey] !== undefined) continue;

    next[accentKey] = color;
    changedEnvironmentIds.add(project.environmentId);
  }

  if (migratedLegacyKeys.size === 0) {
    return { patches: [], nextClientAccentColors: null };
  }

  const nextClientAccentColors = Object.fromEntries(
    legacyEntries.filter(([legacyKey]) => !migratedLegacyKeys.has(legacyKey)),
  );

  return {
    patches: [...changedEnvironmentIds].map((environmentId) => ({
      environmentId,
      projectAccentColors: nextByEnvironment.get(environmentId) ?? {},
    })),
    nextClientAccentColors,
  };
}
