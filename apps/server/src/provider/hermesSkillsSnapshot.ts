// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

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

export function parseHermesSkillsSnapshot(input: unknown): ReadonlyArray<ServerProviderSkill> {
  const decoded = decodeSnapshot(input);
  if (decoded._tag === "Failure") {
    return [];
  }
  const seen = new Set<string>();
  const skills: Array<ServerProviderSkill> = [];
  for (const rawEntry of decoded.value.skills) {
    const entry = decodeEntry(rawEntry);
    if (entry._tag === "Failure") {
      continue;
    }
    const name = entry.value.skill_name.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const description = entry.value.description?.trim();
    skills.push({
      name,
      ...(description ? { description } : {}),
      enabled: true,
    });
  }
  return skills;
}

export const defaultHermesSkillsSnapshotPath = () =>
  NodePath.join(NodeOS.homedir(), ".hermes", ".skills_prompt_snapshot.json");

export function readHermesSkillsSnapshot(
  snapshotPath = defaultHermesSkillsSnapshotPath(),
): Effect.Effect<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = yield* fileSystem.readFileString(snapshotPath);
    const parsed = yield* decodeSnapshotJson(contents);
    return parseHermesSkillsSnapshot(parsed);
  }).pipe(Effect.orElseSucceed(() => []));
}
