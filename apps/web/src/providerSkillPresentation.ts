import type { ServerProviderSkill } from "@t3tools/contracts";

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

const NO_PROVIDER_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

/**
 * Pick which skill list the composer should show.
 *
 * The workspace lookup answers with a bare array, so a failed lookup arrives
 * as `[]` and is indistinguishable from a provider that genuinely has none.
 * Treating empty as "no answer" keeps the provider snapshot's skills on screen
 * instead of blanking the picker; when the provider really has no skills the
 * snapshot is empty too, so the outcome is the same either way.
 */
export function resolveEffectiveProviderSkills(
  workspaceSkills: ReadonlyArray<ServerProviderSkill> | undefined,
  snapshotSkills: ReadonlyArray<ServerProviderSkill> | undefined,
): ReadonlyArray<ServerProviderSkill> {
  if (workspaceSkills && workspaceSkills.length > 0) {
    return workspaceSkills;
  }
  return snapshotSkills ?? NO_PROVIDER_SKILLS;
}

/**
 * Skills the model cannot invoke on its own — Claude's
 * `disable-model-invocation: true` — still belong in the picker, but the
 * agent will not act on the inserted `$name` reference by itself.
 */
export function isProviderSkillManualOnly(
  skill: Pick<ServerProviderSkill, "modelInvocable">,
): boolean {
  return skill.modelInvocable === false;
}

export function formatProviderSkillInstallSource(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): string | null {
  const normalizedPath = skill.path ? normalizePathSeparators(skill.path) : "";
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "App";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  if (normalizedScope === "system") {
    return "System";
  }
  if (
    normalizedScope === "project" ||
    normalizedScope === "workspace" ||
    normalizedScope === "local"
  ) {
    return "Project";
  }
  if (normalizedScope === "user" || normalizedScope === "personal") {
    return "Personal";
  }
  if (normalizedScope) {
    return titleCaseWords(normalizedScope);
  }

  return null;
}
