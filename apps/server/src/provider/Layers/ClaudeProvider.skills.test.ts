import type { ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeClaudeSkills, parseClaudeSkills } from "./ClaudeProvider.ts";

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
        modelInvocable: true,
      },
      {
        name: "plugin:skill",
        description: "Plugin skill",
        enabled: true,
        modelInvocable: true,
      },
    ]);
  });
});

describe("mergeClaudeSkills", () => {
  const userInvocableSkillNames = new Set([
    "deploy",
    "dotfiles-sync",
    "frontend-design:frontend-design",
  ]);
  const discovered: ReadonlyArray<ServerProviderSkill> = [
    {
      name: "deploy",
      description: "Deploy the app.",
      path: "/home/dev/.claude/skills/deploy/SKILL.md",
      scope: "user",
      enabled: true,
    },
    {
      name: "dotfiles-sync",
      description: "Sync dotfiles.",
      path: "/home/dev/.claude/skills/dotfiles-sync/SKILL.md",
      scope: "user",
      enabled: true,
      modelInvocable: false,
    },
  ];

  it("keeps disk-only skills and marks them as not model-invocable", () => {
    const merged = mergeClaudeSkills(
      parseClaudeSkills([
        { name: "deploy", description: "Deploy the app. (user)", argumentHint: "" },
      ]),
      discovered,
      userInvocableSkillNames,
    );

    expect(merged.map((skill) => skill.name)).toEqual(["deploy", "dotfiles-sync"]);
    expect(merged[1]).toEqual({
      name: "dotfiles-sync",
      description: "Sync dotfiles.",
      path: "/home/dev/.claude/skills/dotfiles-sync/SKILL.md",
      scope: "user",
      enabled: true,
      modelInvocable: false,
    });
  });

  it("enriches SDK-reported skills with the filesystem origin the SDK omits", () => {
    const merged = mergeClaudeSkills(
      parseClaudeSkills([
        { name: "deploy", description: "Deploy the app. (user)", argumentHint: "" },
      ]),
      discovered,
      userInvocableSkillNames,
    );

    expect(merged[0]).toEqual({
      name: "deploy",
      description: "Deploy the app. (user)",
      path: "/home/dev/.claude/skills/deploy/SKILL.md",
      scope: "user",
      enabled: true,
      modelInvocable: true,
    });
  });

  it("treats the SDK list as the authority on what the model can invoke", () => {
    // The scan claimed this skill opted out, but the SDK reports it, so the
    // model can reach it after all.
    const merged = mergeClaudeSkills(
      parseClaudeSkills([
        { name: "dotfiles-sync", description: "Sync dotfiles. (user)", argumentHint: "" },
      ]),
      discovered,
      userInvocableSkillNames,
    );

    expect(merged.find((skill) => skill.name === "dotfiles-sync")?.modelInvocable).toBe(true);
  });

  it("carries plugin skills that live outside the scanned directories", () => {
    const merged = mergeClaudeSkills(
      parseClaudeSkills([
        { name: "frontend-design:frontend-design", description: "Design UI", argumentHint: "" },
      ]),
      discovered,
      userInvocableSkillNames,
    );

    expect(merged.map((skill) => skill.name)).toEqual([
      "deploy",
      "dotfiles-sync",
      "frontend-design:frontend-design",
    ]);
    expect(merged[2]?.path).toBeUndefined();
  });

  it("drops model-only skills absent from the user-invocable command list", () => {
    const merged = mergeClaudeSkills(
      parseClaudeSkills([
        { name: "deploy", description: "Deploy the app.", argumentHint: "" },
        { name: "internal-only", description: "Model use only.", argumentHint: "" },
      ]),
      discovered,
      userInvocableSkillNames,
    );

    expect(merged.map((skill) => skill.name)).toEqual(["deploy", "dotfiles-sync"]);
  });
});
