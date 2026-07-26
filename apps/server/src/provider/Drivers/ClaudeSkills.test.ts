import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeSkills } from "./ClaudeSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverClaudeSkills", (it) => {
  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "codex-review",
        [
          "---",
          "name: codex-review",
          "description: Ask Codex for a review.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "codex-review",
          path: path.join(configDir, "skills", "codex-review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Ask Codex for a review.",
        },
        {
          name: "deploy",
          path: path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Deploy the app.",
        },
      ]);
    }),
  );

  it.effect("prefers project skills over user skills on name collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "Deploy",
        ["---", "name: Deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.scope, "project");
      assert.equal(skills[0]?.description, "Project deploy.");
    }),
  );

  it.effect("lets a project model-only skill hide a same-name user skill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "Deploy",
        ["---", "name: Deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        [
          "---",
          "name: deploy",
          "description: Model-only project deploy.",
          "user-invocable: false",
          "---",
        ].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, []);
    }),
  );

  it.effect("falls back to the directory name when frontmatter cannot be trusted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      yield* writeSkill(skillsDir, "broken-yaml", "---\nname: [unclosed\n---\n");
      // A stray file (not a directory with SKILL.md) must be skipped.
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

      // Both surface under their directory name: one has no frontmatter, the
      // other's `name` is not a usable identifier.
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["broken-yaml", "no-frontmatter"],
      );
      assert.equal(skills[0]?.description, undefined);
      assert.equal(skills[1]?.description, undefined);
    }),
  );

  it.effect("recovers metadata from frontmatter that strict YAML rejects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      // `description` holds an unquoted `": "`, which YAML reads as a nested
      // mapping. Claude Code loads this skill, so discovery must too.
      yield* writeSkill(
        skillsDir,
        "codex-computer-use",
        [
          "---",
          "name: codex-computer-use",
          "description: Run verification that needs computer use: browser automation.",
          "---",
        ].join("\n"),
      );
      // An unquoted flow-sequence-looking `argument-hint` breaks the scanner.
      yield* writeSkill(
        skillsDir,
        "nexus",
        [
          "---",
          "name: nexus",
          'description: "Manage \\"Nexus\\" streams." # shown in picker',
          "argument-hint: [command] [args]",
          "---",
        ].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "duplicate-name",
        [
          "---",
          "name: stale-name",
          "name: final-name",
          "argument-hint: [command] [args]",
          "---",
        ].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "nested-name",
        ["---", "metadata:", "  name: nested", "argument-hint: [command] [args]", "---"].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "block-description",
        [
          "---",
          "name: block-description",
          "description: |2-",
          "  Folded text",
          "argument-hint: [command] [args]",
          "---",
        ].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["block-description", "codex-computer-use", "final-name", "nested-name", "nexus"],
      );
      assert.equal(skills[0]?.description, undefined);
      assert.equal(
        skills[1]?.description,
        "Run verification that needs computer use: browser automation.",
      );
      // Duplicate top-level keys use the last value; indented nested keys are
      // never recovered as top-level metadata.
      assert.equal(skills[2]?.scope, "user");
      assert.equal(skills[3]?.name, "nested-name");
      assert.equal(skills[4]?.description, 'Manage "Nexus" streams.');
    }),
  );

  it.effect("flags model-invocation opt-outs and drops user-invocation opt-outs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(
        skillsDir,
        "dotfiles-sync",
        [
          "---",
          "name: dotfiles-sync",
          "description: Sync dotfiles.",
          "user-invocable: true",
          "disable-model-invocation: true",
          "---",
        ].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "internal-only",
        [
          "---",
          "name: internal-only",
          "description: Not for humans.",
          "user-invocable: false # model use only",
          "argument-hint: [command] [args]",
          "---",
        ].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["deploy", "dotfiles-sync"],
      );
      // Unspecified means "no opt-out recorded"; the merge with the SDK list
      // decides the final answer.
      assert.equal(skills[0]?.modelInvocable, undefined);
      assert.equal(skills[1]?.modelInvocable, false);
    }),
  );

  it.effect("honors CLAUDE_CONFIG_DIR from the environment when homePath is unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const environmentConfigDir = path.join(tempDir, "env-config");

      yield* writeSkill(
        path.join(environmentConfigDir, "skills"),
        "env-skill",
        ["---", "name: env-skill", "description: From env config dir.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["env-skill"],
      );

      // An explicit homePath wins over the environment variable, matching
      // makeClaudeEnvironment which overwrites CLAUDE_CONFIG_DIR for the CLI.
      const explicitHome = path.join(tempDir, "explicit-home");
      yield* writeSkill(
        path.join(explicitHome, "skills"),
        "explicit-skill",
        ["---", "name: explicit-skill", "---"].join("\n"),
      );
      const explicitSkills = yield* discoverClaudeSkills({ homePath: explicitHome }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });
      assert.deepEqual(
        explicitSkills.map((skill) => skill.name),
        ["explicit-skill"],
      );
    }),
  );

  it.effect("resolves a relative CLAUDE_CONFIG_DIR against the workspace cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });

      // The spawned CLI resolves a relative CLAUDE_CONFIG_DIR against its own
      // cwd (the workspace), so discovery must do the same.
      yield* writeSkill(
        path.join(workspace, "relative-config", "skills"),
        "relative-skill",
        ["---", "name: relative-skill", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, workspace, {
        CLAUDE_CONFIG_DIR: "relative-config",
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["relative-skill"],
      );
      assert.equal(skills[0]?.scope, "user");
    }),
  );

  it.effect("returns an empty list when no skill roots exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });

      const skills = yield* discoverClaudeSkills(
        { homePath: path.join(tempDir, "missing-home") },
        path.join(tempDir, "missing-workspace"),
      );

      assert.deepEqual(skills, []);
    }),
  );
});

it.layer(NodeServices.layer)("discoverClaudeSkills name handling", (it) => {
  it.effect("uses a parsed frontmatter name verbatim, matching the CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      // Claude Code takes `name` verbatim and reports it as the command name,
      // so a dot (or a space) must not be rewritten to the directory name —
      // that would put the skill under a name no other surface uses.
      yield* writeSkill(
        path.join(configDir, "skills"),
        "t3-setup",
        ["---", "name: t3.setup", "description: Set T3 up.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["t3.setup"],
      );
    }),
  );
});
