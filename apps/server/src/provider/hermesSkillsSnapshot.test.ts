import { describe, expect, it } from "vite-plus/test";

import {
  defaultHermesSkillsSnapshotPath,
  parseHermesSkillsSnapshot,
} from "./hermesSkillsSnapshot.ts";

describe("parseHermesSkillsSnapshot", () => {
  it("parses the Hermes snapshot shape, filters malformed entries, and keeps the first duplicate", () => {
    expect(
      parseHermesSkillsSnapshot({
        version: 1,
        manifest: { generated_at: "2026-07-25T00:00:00Z" },
        skills: [
          {
            skill_name: "review",
            category: "development",
            frontmatter_name: "Review",
            description: "Review a change",
            platforms: ["macos"],
            conditions: {},
          },
          { skill_name: "review", description: "duplicate" },
          { skill_name: "  ship  ", description: "  Ship it  " },
          { description: "missing name" },
          { skill_name: 42, description: "wrong name type" },
        ],
        category_descriptions: { development: "Development skills" },
      }),
    ).toEqual([
      { name: "review", description: "Review a change", enabled: true },
      { name: "ship", description: "Ship it", enabled: true },
    ]);
  });

  it.each([null, {}, { version: 1, manifest: {}, skills: "bad", category_descriptions: {} }])(
    "returns an empty list for an invalid snapshot",
    (input) => {
      expect(parseHermesSkillsSnapshot(input)).toEqual([]);
    },
  );

  it("uses canonical command slugs and projects disabled or incompatible entries", () => {
    expect(
      parseHermesSkillsSnapshot(
        {
          version: 1,
          manifest: {},
          skills: [
            {
              skill_name: "lm-evaluation-harness",
              frontmatter_name: "Evaluating LLMs_Harness",
              platforms: ["linux", "macos"],
            },
            {
              skill_name: "duplicate",
              frontmatter_name: "evaluating--llms-harness",
              platforms: ["macos"],
            },
            {
              skill_name: "windows-only",
              frontmatter_name: "Windows Only",
              platforms: ["windows"],
            },
          ],
          category_descriptions: {},
        },
        {
          disabledSkillNames: new Set(["lm-evaluation-harness"]),
          platform: "darwin",
        },
      ),
    ).toEqual([
      { name: "evaluating-llms-harness", enabled: true },
      { name: "windows-only", enabled: false },
    ]);
  });

  it("resolves the snapshot from the provider instance HERMES_HOME", () => {
    expect(defaultHermesSkillsSnapshotPath({ HERMES_HOME: "/tmp/hermes-profile" }, "darwin")).toBe(
      "/tmp/hermes-profile/.skills_prompt_snapshot.json",
    );
  });
});
