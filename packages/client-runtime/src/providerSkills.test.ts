import type { ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderSkillDisplayName,
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
  isProviderSkillManualOnly,
  resolveEffectiveProviderSkills,
  resolveProviderSkillSourceKind,
} from "./providerSkills.ts";

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("getProviderSkillsForSlashMenu", () => {
  it("keeps the skill alias when the provider also exposes it as a slash command", () => {
    const askMatt = {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    };
    expect(getProviderSkillsForSlashMenu([askMatt], true).map((skill) => skill.name)).toEqual([
      "ask-matt",
    ]);
  });
});

describe("getProviderSlashCommandsForSlashMenu", () => {
  const commands = [
    { name: "ask-matt", description: "Ask which skill fits your situation." },
    { name: "compact", description: "Compact the conversation." },
  ];
  const skills = [
    {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    },
  ];

  it("lets the skill alias win when a provider command has the same name", () => {
    expect(
      getProviderSlashCommandsForSlashMenu(commands, skills).map((command) => command.name),
    ).toEqual(["compact"]);
  });

  it("keeps the provider command when the matching skill alias is hidden", () => {
    const visibleSkills = getProviderSkillsForSlashMenu(skills, false);

    expect(
      getProviderSlashCommandsForSlashMenu(commands, visibleSkills).map((command) => command.name),
    ).toEqual(["ask-matt", "compact"]);
  });
});

describe("resolveProviderSkillSourceKind", () => {
  it("classifies a skill that reports no path by its scope alone", () => {
    expect(resolveProviderSkillSourceKind({ scope: "user" })).toBe("personal");
    expect(resolveProviderSkillSourceKind({})).toBe("other");
  });

  it("marks plugin-backed skills as app installs", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("app");
  });

  it("maps standard scopes to source kinds", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "repo",
      }),
    ).toBe("repo");
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "project",
      }),
    ).toBe("project");
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
        scope: "user",
      }),
    ).toBe("personal");
    expect(
      resolveProviderSkillSourceKind({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("system");
  });

  it("keeps unknown and missing scopes usable", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
        scope: "team_shared",
      }),
    ).toBe("other");
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
      }),
    ).toBe("other");
  });
});

describe("isProviderSkillManualOnly", () => {
  it("flags only skills the provider reported as not model-invocable", () => {
    expect(isProviderSkillManualOnly({ modelInvocable: false })).toBe(true);
    expect(isProviderSkillManualOnly({ modelInvocable: true })).toBe(false);
    // Providers that report nothing must not be labelled either way.
    expect(isProviderSkillManualOnly({})).toBe(false);
  });
});

describe("resolveEffectiveProviderSkills", () => {
  const workspaceSkill: ServerProviderSkill = { name: "deploy", enabled: true };
  const snapshotSkill: ServerProviderSkill = { name: "review", enabled: true };

  it("prefers the workspace lookup when it returned skills", () => {
    expect(resolveEffectiveProviderSkills([workspaceSkill], [snapshotSkill])).toEqual([
      workspaceSkill,
    ]);
  });

  it("keeps snapshot skills when the workspace lookup has not answered", () => {
    expect(resolveEffectiveProviderSkills(undefined, [snapshotSkill])).toEqual([snapshotSkill]);
  });

  it("keeps snapshot skills when the workspace lookup answered with nothing", () => {
    // An empty array is what a failed lookup looks like on the wire, so it
    // must not blank a picker that had skills a moment ago.
    expect(resolveEffectiveProviderSkills([], [snapshotSkill])).toEqual([snapshotSkill]);
  });

  it("returns an empty list when neither source has skills", () => {
    expect(resolveEffectiveProviderSkills([], undefined)).toEqual([]);
  });
});
