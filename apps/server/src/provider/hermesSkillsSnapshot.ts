// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderSkill } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

const HermesSkillSnapshotEntry = Schema.Struct({
  skill_name: Schema.String,
  description: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  frontmatter_name: Schema.optional(Schema.String),
  platforms: Schema.optional(Schema.Array(Schema.String)),
  conditions: Schema.optional(Schema.Unknown),
});

const HermesSkillsSnapshot = Schema.Struct({
  version: Schema.Number,
  manifest: Schema.Record(Schema.String, Schema.Unknown),
  skills: Schema.Array(Schema.Unknown),
  category_descriptions: Schema.Record(Schema.String, Schema.Unknown),
});

const decodeSnapshot = Schema.decodeUnknownExit(HermesSkillsSnapshot);
const decodeSnapshotJson = Schema.decodeUnknownEffect(Schema.fromJsonString(HermesSkillsSnapshot));
const decodeEntry = Schema.decodeUnknownExit(HermesSkillSnapshotEntry);

export interface HermesSkillsSnapshotParseOptions {
  readonly disabledSkillNames?: ReadonlySet<string>;
  readonly platform?: string;
}

function normalizeHermesSkillCommandName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[ _]/gu, "-")
    .replace(/[^a-z0-9-]/gu, "")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function hermesPlatformName(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return platform;
  }
}

export function parseHermesSkillsSnapshot(
  input: unknown,
  options: HermesSkillsSnapshotParseOptions = {},
): ReadonlyArray<ServerProviderSkill> {
  const decoded = decodeSnapshot(input);
  if (decoded._tag === "Failure") {
    return [];
  }
  const skillsByCommandName = new Map<string, ServerProviderSkill>();
  const currentPlatform = options.platform ? hermesPlatformName(options.platform) : undefined;
  for (const rawEntry of decoded.value.skills) {
    const entry = decodeEntry(rawEntry);
    if (entry._tag === "Failure") {
      continue;
    }
    const skillName = entry.value.skill_name.trim();
    const frontmatterName = entry.value.frontmatter_name?.trim() || skillName;
    const name = normalizeHermesSkillCommandName(frontmatterName);
    if (!skillName || !name) {
      continue;
    }
    const platforms = entry.value.platforms?.map((platform) => platform.trim().toLowerCase()) ?? [];
    const platformMatches =
      currentPlatform === undefined ||
      platforms.length === 0 ||
      platforms.includes(currentPlatform);
    const disabled =
      options.disabledSkillNames?.has(skillName) === true ||
      options.disabledSkillNames?.has(frontmatterName) === true;
    const description = entry.value.description?.trim();
    const skill = {
      name,
      ...(description ? { description } : {}),
      enabled: platformMatches && !disabled,
    } satisfies ServerProviderSkill;
    const existing = skillsByCommandName.get(name);
    if (existing === undefined || (!existing.enabled && skill.enabled)) {
      skillsByCommandName.set(name, skill);
    }
  }
  return [...skillsByCommandName.values()];
}

function defaultHermesHome(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const configuredHome = environment.HERMES_HOME?.trim();
  if (configuredHome) {
    return configuredHome;
  }
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim();
    return NodePath.join(
      localAppData || NodePath.join(NodeOS.homedir(), "AppData", "Local"),
      "hermes",
    );
  }
  return NodePath.join(NodeOS.homedir(), ".hermes");
}

export const defaultHermesSkillsSnapshotPath = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) => NodePath.join(defaultHermesHome(environment, platform), ".skills_prompt_snapshot.json");

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseDisabledSkillNames(
  input: unknown,
  platform: string | undefined,
): ReadonlySet<string> {
  if (!isRecord(input) || !isRecord(input.skills)) {
    return new Set();
  }
  const disabled = new Set<string>();
  const addNames = (value: unknown) => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const name of value) {
      if (typeof name === "string" && name.trim()) {
        disabled.add(name.trim());
      }
    }
  };
  addNames(input.skills.disabled);
  if (platform && isRecord(input.skills.platform_disabled)) {
    addNames(input.skills.platform_disabled[platform]);
  }
  return disabled;
}

export interface HermesSkillsSnapshotReadOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly snapshotPath?: string;
  readonly configPath?: string;
}

export function readHermesSkillsSnapshot(
  options: HermesSkillsSnapshotReadOptions = {},
): Effect.Effect<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const platform = yield* HostProcessPlatform;
    const environment = options.environment ?? process.env;
    const hermesHome = defaultHermesHome(environment, platform);
    const snapshotPath =
      options.snapshotPath ?? NodePath.join(hermesHome, ".skills_prompt_snapshot.json");
    const configPath = options.configPath ?? NodePath.join(hermesHome, "config.yaml");
    const contents = yield* fileSystem.readFileString(snapshotPath);
    const parsed = yield* decodeSnapshotJson(contents);
    const configContents = yield* fileSystem
      .readFileString(configPath)
      .pipe(Effect.orElseSucceed(() => ""));
    const config = yield* Effect.try({
      try: () => (configContents ? parseYamlDocument(configContents) : {}),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const platformScope =
      environment.HERMES_PLATFORM?.trim() || environment.HERMES_SESSION_PLATFORM?.trim();
    return parseHermesSkillsSnapshot(parsed, {
      disabledSkillNames: parseDisabledSkillNames(config, platformScope),
      platform,
    });
  }).pipe(Effect.orElseSucceed(() => []));
}
