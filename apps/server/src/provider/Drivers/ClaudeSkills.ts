/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope) and
 * `<cwd>/.agents/skills` and `<cwd>/.claude/skills` (project scope), one
 * directory per skill with a `SKILL.md` carrying YAML frontmatter. Project
 * roots override the user root, and `.claude/skills` has highest precedence.
 * The Agent SDK init handshake surfaces skills only as slash commands without
 * their filesystem paths, so the provider snapshot scans the same locations
 * directly, mirroring how the Codex app-server reports its skills.
 *
 * The scan is also merged into the live `skills/reload` result, because that
 * list covers only skills the *model* may invoke. Skills marked
 * `disable-model-invocation: true` are absent from it while remaining
 * perfectly runnable by hand — see `mergeClaudeSkills`.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { parse as parseYamlDocument } from "yaml";

import { resolveClaudeConfigDirPath } from "./ClaudeHome.ts";

type ClaudeSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const BLOCK_SCALAR_HEADER_PATTERN = /^[>|](?:[+-]?\d*|\d+[+-]?)$/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | {
      readonly kind: "parsed";
      readonly name?: string;
      readonly description?: string;
      readonly userInvocationOnly?: boolean;
      readonly userInvocable?: boolean;
      readonly modelInvocable?: boolean;
    };

/** Drop a trailing `# comment`, honouring quoted spans that may contain `#`. */
function stripRawYamlComment(value: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (quote === '"') {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (quote === "'") {
      if (character === quote && value.charAt(index + 1) === quote) {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(value.charAt(index - 1)))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function readRawFrontmatterField(frontmatter: string, field: string): string | undefined {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedField}[ \\t]*:[ \\t]*(.*)$`, "gm");
  let match: RegExpExecArray | null;
  let matchedValue: string | undefined;
  while ((match = pattern.exec(frontmatter)) !== null) {
    matchedValue = match[1] ?? "";
  }
  if (matchedValue === undefined) return undefined;

  const raw = stripRawYamlComment(matchedValue).trim();
  if (BLOCK_SCALAR_HEADER_PATTERN.test(raw)) return undefined;
  if (raw.length >= 2) {
    const first = raw.charAt(0);
    if ((first === '"' || first === "'") && raw.endsWith(first)) {
      try {
        const decoded = parseYamlDocument(raw);
        if (typeof decoded === "string") return decoded.trim();
      } catch {
        // Keep the tolerant fallback for malformed quoted scalars.
      }
      return raw.slice(1, -1).trim();
    }
  }
  return raw;
}

function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
    case "1":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
    case "0":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  const frontmatter = match[1] ?? "";
  let record: Record<string, unknown> = {};
  try {
    const parsed = parseYamlDocument(frontmatter);
    if (typeof parsed === "object" && parsed !== null) {
      record = parsed as Record<string, unknown>;
    }
  } catch {
    // Leave `record` empty and fall through to the raw line scan below.
  }

  const readString = (field: string): string => {
    const parsed = record[field];
    return (
      (typeof parsed === "string" && parsed.trim() ? parsed.trim() : undefined) ??
      readRawFrontmatterField(frontmatter, field)?.trim() ??
      ""
    );
  };
  const readBoolean = (field: string): boolean | undefined =>
    parseFrontmatterBoolean(record[field]) ??
    parseFrontmatterBoolean(readRawFrontmatterField(frontmatter, field));

  const parsedNameValue = record.name;
  const parsedName =
    typeof parsedNameValue === "string" && parsedNameValue.trim()
      ? parsedNameValue.trim()
      : undefined;
  const recoveredName = parsedName ?? readRawFrontmatterField(frontmatter, "name")?.trim() ?? "";
  const name =
    parsedName !== undefined || SKILL_NAME_PATTERN.test(recoveredName) ? recoveredName : undefined;
  const description = readString("description");
  const userInvocable = readBoolean("user-invocable");
  const disableModelInvocation = readBoolean("disable-model-invocation");
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(userInvocable === undefined ? {} : { userInvocable }),
    ...(disableModelInvocation === undefined
      ? {}
      : {
          modelInvocable: !disableModelInvocation,
          ...(disableModelInvocation ? { userInvocationOnly: true } : {}),
        }),
  };
}

/**
 * Where an administrator installs the policy file whose settings outrank every
 * user and project one. Absent on almost every machine, which is why a missing
 * file is the normal case rather than an error.
 */
export function claudeManagedSettingsPath(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = environment.PROGRAMDATA?.trim();
    return programData ? path.join(programData, "ClaudeCode", "managed-settings.json") : undefined;
  }
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Settings files Claude Code merges for `skillOverrides`, in increasing
 * precedence: user, project, project-local, then the administrator's managed
 * policy, which wins outright. When the workspace sits inside a git
 * repository, the repository root's `settings.local.json` is read too and
 * outranks the workspace's own local file. Verified against the CLI from a
 * nested cwd: a root local file switching a skill off wins over a cwd one
 * switching it on, the root's plain `settings.json` is not consulted, and
 * without a `.git` above the cwd no root file is read. A skill the user
 * switched off is reported disabled rather than dropped, so the picker can
 * grey it out instead of silently losing it.
 */
export function skillOverrideSettingsPaths(
  path: Path.Path,
  configDirPath: string,
  cwd: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  repositoryRoot?: string,
): ReadonlyArray<string> {
  const managedPath = claudeManagedSettingsPath(path, platform, environment);
  const root = repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined;
  return [
    path.join(configDirPath, "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
    ...(root ? [path.join(root, ".claude", "settings.local.json")] : []),
    ...(managedPath ? [managedPath] : []),
  ];
}

/**
 * Nearest ancestor of `cwd` (inclusive) holding a `.git` entry, which is the
 * boundary Claude Code walks up to for project settings. `undefined` outside
 * a repository.
 */
const findRepositoryRoot = Effect.fn("findRepositoryRoot")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(cwd);
  while (true) {
    const isRoot = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isRoot) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
});

/**
 * The four states Claude Code accepts. The CLI validates the whole map, not
 * each entry: verified against it, one entry with an unknown value (or a
 * boolean) makes it drop every override in that file, so this schema does the
 * same rather than applying the valid siblings the CLI ignores.
 */
const SkillOverrideValue = Schema.Literals(["on", "name-only", "user-invocable-only", "off"]);

// Lenient because these settings files are hand-edited and Claude Code itself
// tolerates comments and trailing commas in them.
const SkillOverrideSettings = fromLenientJson(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
  }),
);
const decodeSkillOverrideSettings = Schema.decodeUnknownEffect(SkillOverrideSettings);

/**
 * What a `skillOverrides` entry says about one skill. `"user-invocable-only"`
 * hides it from the agent exactly as `disable-model-invocation` does, so it is
 * kept apart from a plain on/off decision rather than collapsed into one.
 */
type SkillOverride = {
  readonly enabled: boolean;
  readonly userInvocationOnly: boolean;
};

function parseSkillOverride(value: typeof SkillOverrideValue.Type): SkillOverride {
  switch (value) {
    case "off":
      return { enabled: false, userInvocationOnly: false };
    case "user-invocable-only":
      return { enabled: true, userInvocationOnly: true };
    case "on":
    case "name-only":
      return { enabled: true, userInvocationOnly: false };
  }
}

const readSkillOverrides = Effect.fn("readSkillOverrides")(function* (
  configDirPath: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyMap<string, SkillOverride>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const overridesByName = new Map<string, SkillOverride>();
  const repositoryRoot = cwd === undefined ? undefined : yield* findRepositoryRoot(cwd);

  for (const settingsPath of skillOverrideSettingsPaths(
    path,
    configDirPath,
    cwd,
    platform,
    environment,
    repositoryRoot,
  )) {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }

    const parsed = yield* decodeSkillOverrideSettings(contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude settings file is unreadable; ignoring skillOverrides", {
          path: settingsPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    const overrides = parsed?.skillOverrides;
    if (!overrides) {
      continue;
    }

    for (const [name, value] of Object.entries(overrides)) {
      overridesByName.set(name, parseSkillOverride(value));
    }
  }

  return overridesByName;
});

/**
 * Enumerate Claude Code skills from the user config dir, workspace
 * `.agents/skills`, and workspace `.claude/skills`. Discovery is best-effort:
 * unreadable roots are skipped and tolerant frontmatter recovery keeps runnable
 * skills visible. Parsed frontmatter names match the CLI command verbatim;
 * directory names are the fallback. Later roots win on command-name collisions.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);
  const skillOverrides = yield* readSkillOverrides(configDirPath, cwd, environment ?? process.env);

  const roots: ReadonlyArray<{ directory: string; scope: ClaudeSkillScope }> = [
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".claude", "skills"), scope: "project" as const },
        ]
      : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) {
        continue;
      }

      const key = name.toLowerCase();
      const override = skillOverrides.get(name);
      const description = frontmatter.kind === "parsed" ? frontmatter.description : undefined;
      const userInvocable = frontmatter.kind === "parsed" ? frontmatter.userInvocable : undefined;
      const frontmatterModelInvocable =
        frontmatter.kind === "parsed" ? frontmatter.modelInvocable : undefined;
      const userInvocationOnly =
        (frontmatter.kind === "parsed" && frontmatter.userInvocationOnly === true) ||
        override?.userInvocationOnly === true;
      const modelInvocable = userInvocationOnly ? false : frontmatterModelInvocable;

      skillsByName.set(key, {
        name,
        path: skillPath,
        enabled: override?.enabled ?? true,
        scope: root.scope,
        ...(description ? { description } : {}),
        ...(modelInvocable === undefined ? {} : { modelInvocable }),
        ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
        ...(userInvocable === undefined ? {} : { userInvocable }),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
