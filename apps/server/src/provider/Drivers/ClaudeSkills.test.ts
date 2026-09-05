import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeSkills, skillOverrideSettingsPaths } from "./ClaudeSkills.ts";

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

  it.effect("discovers workspace .agents/skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "review",
        ["---", "name: review", "description: Review the changes.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "review",
          path: path.join(workspace, ".agents", "skills", "review", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Review the changes.",
        },
      ]);
    }),
  );

  it.effect("uses .claude over .agents and user skills on command-name collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Agents deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Claude deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "deploy",
          path: path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Claude deploy.",
        },
      ]);
    }),
  );

  it.effect("prefers project skills over user skills on case-insensitive name collisions", () =>
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

  it.effect("lets a project model-only skill replace a same-name user skill", () =>
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

      assert.deepEqual(skills, [
        {
          name: "deploy",
          path: path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Model-only project deploy.",
          userInvocable: false,
        },
      ]);
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

  it.effect("records model- and user-invocation opt-outs", () =>
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
        skills.map((skill) => [
          skill.name,
          skill.modelInvocable,
          skill.userInvocable,
          skill.userInvocationOnly === true,
        ]),
        [
          ["deploy", undefined, undefined, false],
          ["dotfiles-sync", false, true, true],
          ["internal-only", undefined, false, false],
        ],
      );
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

  it.effect("marks skills that only the user can invoke", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "re-release-version",
        [
          "---",
          "name: re-release-version",
          "description: Move the current tag forward.",
          "disable-model-invocation: true",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "release-version",
        ["---", "name: release-version", "description: Cut a release.", "---", "", "# Body"].join(
          "\n",
        ),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.equal(
        skills.find((skill) => skill.name === "re-release-version")?.userInvocationOnly,
        true,
      );
      assert.equal(
        skills.find((skill) => skill.name === "release-version")?.userInvocationOnly,
        undefined,
      );
    }),
  );

  it.effect("disables skills switched off by skillOverrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      for (const name of ["kept", "off-by-user", "off-by-project"]) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          name,
          ["---", `name: ${name}`, "---", "", "# Body"].join("\n"),
        );
      }

      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "off-by-user": "off", "kept": "on" } }',
      );
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.json"),
        '{ "skillOverrides": { "off-by-project": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [
          ["kept", true],
          ["off-by-project", false],
          ["off-by-user", false],
        ],
      );
    }),
  );

  it.effect("ignores unreadable settings when resolving skillOverrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "kept",
        ["---", "name: kept", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(path.join(configDir, "settings.json"), "{ not json");

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["kept", true]],
      );
    }),
  );

  it.effect("treats a user-invocable-only override like disable-model-invocation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "ask-matt",
        ["---", "name: ask-matt", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "ask-matt": "user-invocable-only" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [
          skill.name,
          skill.enabled,
          skill.userInvocationOnly === true,
          skill.modelInvocable,
        ]),
        [["ask-matt", true, true, false]],
      );
    }),
  );

  it.effect("drops every override in a file when one value is invalid, as Claude Code does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      for (const name of ["unknown-mode", "boolean-false", "sibling-off"]) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          name,
          ["---", `name: ${name}`, "---", "", "# Body"].join("\n"),
        );
      }
      // Verified against the CLI: with an unknown string or a boolean in the
      // map, the valid "off" sibling is ignored too and every skill runs.
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "unknown-mode": "some-future-mode", "boolean-false": false, "sibling-off": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [
          ["boolean-false", true],
          ["sibling-off", true],
          ["unknown-mode", true],
        ],
      );
    }),
  );

  it.effect("reads repository root settings from a nested workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const repo = path.join(tempDir, "repo");
      const workspace = path.join(repo, "packages", "app");

      for (const name of ["root-off", "root-off-cwd-on", "cwd-off-root-on"]) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          name,
          ["---", `name: ${name}`, "---", "", "# Body"].join("\n"),
        );
      }
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(repo, ".claude"), { recursive: true });
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      // The CLI ignores the root's plain settings.json from a nested cwd.
      yield* fs.writeFileString(
        path.join(repo, ".claude", "settings.json"),
        '{ "skillOverrides": { "cwd-off-root-on": "off" } }',
      );
      // The root local file outranks the workspace local file, as in the CLI.
      yield* fs.writeFileString(
        path.join(repo, ".claude", "settings.local.json"),
        '{ "skillOverrides": { "root-off": "off", "root-off-cwd-on": "off", "cwd-off-root-on": "on" } }',
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{ "skillOverrides": { "root-off-cwd-on": "on", "cwd-off-root-on": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [
          ["cwd-off-root-on", true],
          ["root-off", false],
          ["root-off-cwd-on", false],
        ],
      );
    }),
  );

  it.effect("ignores ancestor settings outside a repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const parent = path.join(tempDir, "not-a-repo");
      const workspace = path.join(parent, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "kept",
        ["---", "name: kept", "---", "", "# Body"].join("\n"),
      );
      yield* fs.makeDirectory(path.join(parent, ".claude"), { recursive: true });
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* fs.writeFileString(
        path.join(parent, ".claude", "settings.local.json"),
        '{ "skillOverrides": { "kept": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["kept", true]],
      );
    }),
  );

  it.effect("lets the administrator's managed policy outrank every other settings file", () =>
    Effect.gen(function* () {
      // The function is pure on its `path` argument, so hand it the
      // implementation matching each platform under test rather than the
      // host's.
      const path = yield* Path.Path.pipe(Effect.provide(NodePath.layerPosix));
      const win32Path = yield* Path.Path.pipe(Effect.provide(NodePath.layerWin32));

      for (const [platform, expected] of [
        ["darwin", "/Library/Application Support/ClaudeCode/managed-settings.json"],
        ["linux", "/etc/claude-code/managed-settings.json"],
      ] as const) {
        const paths = skillOverrideSettingsPaths(path, "/home/.claude", "/workspace", platform, {});
        assert.deepEqual(paths, [
          "/home/.claude/settings.json",
          "/workspace/.claude/settings.json",
          "/workspace/.claude/settings.local.json",
          expected,
        ]);
      }

      assert.deepEqual(
        skillOverrideSettingsPaths(win32Path, "C:\\Users\\me\\.claude", undefined, "win32", {
          PROGRAMDATA: "C:\\ProgramData",
        }).at(-1),
        "C:\\ProgramData\\ClaudeCode\\managed-settings.json",
      );
      assert.deepEqual(
        skillOverrideSettingsPaths(win32Path, "C:\\Users\\me\\.claude", undefined, "win32", {}),
        ["C:\\Users\\me\\.claude\\settings.json"],
      );

      // Only the repository root's local file joins in, after the
      // workspace's own local file so it wins.
      assert.deepEqual(
        skillOverrideSettingsPaths(
          path,
          "/home/.claude",
          "/repo/packages/app",
          "linux",
          {},
          "/repo",
        ),
        [
          "/home/.claude/settings.json",
          "/repo/packages/app/.claude/settings.json",
          "/repo/packages/app/.claude/settings.local.json",
          "/repo/.claude/settings.local.json",
          "/etc/claude-code/managed-settings.json",
        ],
      );
      // A workspace that is the root itself is not read twice.
      assert.deepEqual(
        skillOverrideSettingsPaths(path, "/home/.claude", "/repo", "linux", {}, "/repo"),
        [
          "/home/.claude/settings.json",
          "/repo/.claude/settings.json",
          "/repo/.claude/settings.local.json",
          "/etc/claude-code/managed-settings.json",
        ],
      );
    }),
  );

  it.effect("records a skill Claude Code keeps out of its own slash commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "agent-only",
        ["---", "name: agent-only", "user-invocable: false", "---", "", "# Body"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.userInvocable]),
        [["agent-only", false]],
      );
    }),
  );

  it.effect("identifies a skill by its parsed frontmatter name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "probe-alias",
        ["---", "name: probe-alias-frontmatter", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "probe-alias-frontmatter": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["probe-alias-frontmatter", false]],
      );
    }),
  );

  it.effect("does not apply a directory-name override to a frontmatter-named skill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "probe-alias",
        ["---", "name: probe-alias-frontmatter", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "probe-alias": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["probe-alias-frontmatter", true]],
      );
    }),
  );

  it.effect("accepts the YAML 1.1 boolean spellings Claude Code allows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(
        skillsDir,
        "user-only-yes",
        ["---", "disable-model-invocation: yes", "---", "", "# Body"].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "agent-only-no",
        ["---", "user-invocable: no", "---", "", "# Body"].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "plain-off",
        ["---", "disable-model-invocation: off", "---", "", "# Body"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [
          skill.name,
          skill.userInvocationOnly === true,
          skill.userInvocable === false,
        ]),
        [
          ["agent-only-no", false, true],
          ["plain-off", false, false],
          ["user-only-yes", true, false],
        ],
      );
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
