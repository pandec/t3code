import { describe, expect, it } from "vite-plus/test";

import { parseHermesSkillsSnapshot } from "./hermesSkillsSnapshot.ts";

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
            platforms: ["darwin"],
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
});
