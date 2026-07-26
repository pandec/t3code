/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope) and
 * `<cwd>/.claude/skills` (project scope), one directory per skill with a
 * `SKILL.md` carrying YAML frontmatter. The Agent SDK init handshake surfaces
 * skills only as slash commands without their filesystem paths, so the
 * provider snapshot scans the same locations directly, mirroring how the
 * Codex app-server reports its skills.
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

/**
 * Read one scalar field out of raw frontmatter without a YAML parser.
 *
 * Claude Code tolerates frontmatter that strict YAML rejects — an unquoted
 * `description` containing `": "` parses as a nested mapping, and an
 * `argument-hint: [cmd] [args]` trips the flow-sequence scanner. Those skills
 * load fine in Claude Code, so scanning them out here would hide skills the
 * user can actually run. Falling back to a line scan keeps such skills
 * discoverable with their real metadata.
 */
function readRawFrontmatterField(frontmatter: string, field: string): string | undefined {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedField}[ \\t]*:[ \\t]*(.*)$`, "gm");
  let match: RegExpExecArray | null;
  let matchedValue: string | undefined;
  while ((match = pattern.exec(frontmatter)) !== null) {
    // Match only column-zero keys, and use the last duplicate just like the
    // effective value in tolerant last-write-wins YAML loaders.
    matchedValue = match[1] ?? "";
  }
  if (matchedValue === undefined) {
    return undefined;
  }

  const raw = stripRawYamlComment(matchedValue).trim();
  // A block-scalar header carries no value of its own, and the folded lines
  // that follow are out of reach of a single-line scan.
  if (BLOCK_SCALAR_HEADER_PATTERN.test(raw)) {
    return undefined;
  }
  if (raw.length >= 2) {
    const first = raw.charAt(0);
    if ((first === '"' || first === "'") && raw.endsWith(first)) {
      try {
        const decoded = parseYamlDocument(raw);
        if (typeof decoded === "string") {
          return decoded.trim();
        }
      } catch {
        // Keep the tolerant legacy fallback for malformed quoted scalars.
      }
      return raw.slice(1, -1).trim();
    }
  }
  return raw;
}

function parseBooleanField(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
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

  /** True when a value came from the YAML parse rather than the line scan. */
  const parsedString = (field: string): string | undefined => {
    const value = record[field];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const readString = (field: string): string =>
    parsedString(field) ?? readRawFrontmatterField(frontmatter, field)?.trim() ?? "";
  const readBoolean = (field: string): boolean | undefined => {
    const value = record[field];
    if (typeof value === "boolean") {
      return value;
    }
    return parseBooleanField(readRawFrontmatterField(frontmatter, field));
  };

  // Claude Code takes a parsed `name` verbatim, so match it — the CLI reports
  // that exact string as the command name, and rewriting it here would put the
  // skill under a name no other surface uses. A name *recovered* from a failed
  // parse is only trustworthy when it looks like a bare identifier; anything
  // else (`name: [unclosed`) is genuine breakage, and the directory name is the
  // safer answer.
  const parsedName = parsedString("name");
  const recoveredName = parsedName ?? readString("name");
  const name =
    parsedName !== undefined || SKILL_NAME_PATTERN.test(recoveredName) ? recoveredName : "";
  const description = readString("description");
  const userInvocable = readBoolean("user-invocable");
  const disableModelInvocation = readBoolean("disable-model-invocation");
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(userInvocable === undefined ? {} : { userInvocable }),
    ...(disableModelInvocation === undefined ? {} : { modelInvocable: !disableModelInvocation }),
  };
}

/**
 * Enumerate Claude Code skills from the user config dir and the workspace.
 * Discovery is best-effort: unreadable roots and unnamed entries are skipped
 * so a broken skill never degrades the provider snapshot. On name collisions
 * the project-scoped skill wins, matching Claude Code's most-specific-wins
 * resolution.
 *
 * Skills that opt out of user invocation (`user-invocable: false`) are
 * omitted — the composer picker is a user-facing surface. Skills that only opt
 * out of *model* invocation are kept and flagged via `modelInvocable`, because
 * the provider-native list drops them entirely and they are exactly the ones
 * a user reaches for by hand.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);

  const roots: ReadonlyArray<{ directory: string; scope: ClaudeSkillScope }> = [
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".claude", "skills"), scope: "project" as const }] : []),
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
      if (frontmatter.kind === "parsed" && frontmatter.userInvocable === false) {
        // A project-scoped model-only skill still shadows a same-name user
        // skill; deleting the earlier entry preserves most-specific-wins.
        skillsByName.delete(key);
        continue;
      }

      const description = frontmatter.kind === "parsed" ? frontmatter.description : undefined;
      const modelInvocable = frontmatter.kind === "parsed" ? frontmatter.modelInvocable : undefined;
      skillsByName.set(key, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(description ? { description } : {}),
        ...(modelInvocable === undefined ? {} : { modelInvocable }),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
