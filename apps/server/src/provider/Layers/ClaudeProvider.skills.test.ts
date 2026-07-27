import type { ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  gateClaudeSkillsByUserInvocation,
  mergeClaudeSkills,
  parseClaudeSkills,
} from "./ClaudeProvider.ts";

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

  it("defers to the SDK list over a frontmatter model-invocation opt-out", () => {
    // Defensive precedence: the CLI caps an author-locked opt-out at
    // user-invocable-only and never reports it from `skills/reload`, so this
    // disagreement should not arise. If it ever does, the live list wins.
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
    // A plugin skill declaring `name:` is reported unqualified, so it can
    // collide with a same-named user skill; the qualified form only appears
    // when the plugin omits `name:`.
    const merged = mergeClaudeSkills(
      parseClaudeSkills([
        { name: "design-review", description: "Review UI", argumentHint: "" },
        { name: "superpowers:brainstorm", description: "Brainstorm", argumentHint: "" },
      ]),
      discovered,
      new Set([...userInvocableSkillNames, "design-review", "superpowers:brainstorm"]),
    );

    expect(merged.map((skill) => skill.name)).toEqual([
      "deploy",
      "design-review",
      "dotfiles-sync",
      "superpowers:brainstorm",
    ]);
    // Neither lives under a scanned root, so no filesystem origin is invented.
    expect(merged[1]?.path).toBeUndefined();
    expect(merged[1]?.scope).toBeUndefined();
    expect(merged[3]?.path).toBeUndefined();
  });

  it("gives a colliding plugin skill the scanned skill's origin", () => {
    // Known consequence of merging by name: when a plugin skill and a user
    // skill share a name, the picker shows the scanned origin. Claude Code
    // resolves one of the two as well, so a single entry is right.
    const merged = mergeClaudeSkills(
      parseClaudeSkills([{ name: "deploy", description: "Plugin deploy", argumentHint: "" }]),
      discovered,
      userInvocableSkillNames,
    );

    expect(merged.filter((skill) => skill.name === "deploy")).toHaveLength(1);
    expect(merged[0]?.description).toBe("Plugin deploy");
    expect(merged[0]?.scope).toBe("user");
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

describe("gateClaudeSkillsByUserInvocation", () => {
  const skills: ReadonlyArray<ServerProviderSkill> = [
    { name: "Deploy", enabled: true },
    { name: "internal-only", enabled: true, modelInvocable: true },
  ];

  it("drops skills the command list does not report, ignoring case", () => {
    const gated = gateClaudeSkillsByUserInvocation(skills, new Set(["deploy"]));

    expect(gated.map((skill) => skill.name)).toEqual(["Deploy"]);
  });

  it("preserves each skill's model-invocation flag", () => {
    // Without the SDK list there is no evidence about model reachability, so
    // the flag must survive untouched rather than being forced to false.
    const gated = gateClaudeSkillsByUserInvocation(skills, new Set(["deploy", "internal-only"]));

    expect(gated[0]?.modelInvocable).toBeUndefined();
    expect(gated[1]?.modelInvocable).toBe(true);
  });

  it("gates nothing when the command list is absent or empty", () => {
    expect(gateClaudeSkillsByUserInvocation(skills, undefined)).toEqual(skills);
    expect(gateClaudeSkillsByUserInvocation(skills, new Set())).toEqual(skills);
  });
});
