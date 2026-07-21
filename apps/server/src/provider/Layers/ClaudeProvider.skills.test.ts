import { describe, expect, it } from "vite-plus/test";

import { parseClaudeSkills } from "./ClaudeProvider.ts";

describe("parseClaudeSkills", () => {
  it("maps genuine Claude skill metadata without inventing filesystem origins", () => {
    expect(
      parseClaudeSkills([
        {
          name: "project-review",
          description: "Review this project",
          argumentHint: "<path>",
        },
        {
          name: "PROJECT-REVIEW",
          description: "Duplicate",
          argumentHint: "",
        },
        {
          name: "plugin:skill",
          description: "Plugin skill",
          argumentHint: "",
        },
        {
          name: "   ",
          description: "Ignored",
          argumentHint: "",
        },
      ]),
    ).toEqual([
      {
        name: "project-review",
        description: "Review this project",
        enabled: true,
      },
      {
        name: "plugin:skill",
        description: "Plugin skill",
        enabled: true,
      },
    ]);
  });
});
