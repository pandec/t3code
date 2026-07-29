import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ClaudeShadowHomeEntryConflictError,
  ClaudeShadowHomePathConflictError,
  materializeClaudeShadowHome,
  resolveClaudeHomeLayout,
  type ClaudeHomeLayout,
} from "./ClaudeHomeLayout.ts";

const makeTempDir = Effect.fn("ClaudeHomeLayout.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("ClaudeHomeLayout.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

const readLinkTarget = Effect.fn("ClaudeHomeLayout.test.readLinkTarget")(function* (
  linkPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readLink(linkPath);
});

const overlayLayout = (sharedConfigDirPath: string, shadowConfigDirPath: string) =>
  ({
    mode: "authOverlay",
    sharedConfigDirPath,
    shadowConfigDirPath,
  }) satisfies ClaudeHomeLayout;

it.layer(NodeServices.layer)("ClaudeHomeLayout", (it) => {
  describe("resolveClaudeHomeLayout", () => {
    it.effect("runs directly on the shared config dir when no shadow is configured", () =>
      Effect.gen(function* () {
        const shared = yield* makeTempDir("t3code-claude-shared-");

        const layout = yield* resolveClaudeHomeLayout({ homePath: shared, shadowHomePath: "" });

        expect(layout).toEqual({
          mode: "direct",
          sharedConfigDirPath: shared,
          shadowConfigDirPath: undefined,
        });
      }),
    );

    it.effect("overlays the shadow config dir on the shared config dir", () =>
      Effect.gen(function* () {
        const shared = yield* makeTempDir("t3code-claude-shared-");
        const shadow = yield* makeTempDir("t3code-claude-shadow-");

        const layout = yield* resolveClaudeHomeLayout({
          homePath: shared,
          shadowHomePath: shadow,
        });

        expect(layout).toEqual({
          mode: "authOverlay",
          sharedConfigDirPath: shared,
          shadowConfigDirPath: shadow,
        });
      }),
    );

    it.effect("resolves the shared config dir from the environment when homePath is unset", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const shadow = yield* makeTempDir("t3code-claude-shadow-");
        const configDir = path.resolve("/tmp/claude-environment-home");

        const layout = yield* resolveClaudeHomeLayout(
          { homePath: "", shadowHomePath: shadow },
          { CLAUDE_CONFIG_DIR: configDir },
        );

        expect(layout.sharedConfigDirPath).toBe(configDir);
        expect(layout.shadowConfigDirPath).toBe(shadow);
      }),
    );
  });

  describe("materializeClaudeShadowHome", () => {
    it.effect("creates the shadow config dir with session state linked to the shared dir", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* makeTempDir("t3code-claude-overlay-");
        const shared = path.join(root, "shared");
        const shadow = path.join(root, "shadow");
        yield* writeTextFile(path.join(shared, "settings.json"), "{}\n");
        yield* writeTextFile(path.join(shared, "skills", "demo", "SKILL.md"), "# demo\n");

        yield* materializeClaudeShadowHome(overlayLayout(shared, shadow));

        expect(yield* readLinkTarget(path.join(shadow, "projects"))).toBe(
          path.join(shared, "projects"),
        );
        expect(yield* readLinkTarget(path.join(shadow, "settings.json"))).toBe(
          path.join(shared, "settings.json"),
        );
        expect(yield* readLinkTarget(path.join(shadow, "skills"))).toBe(
          path.join(shared, "skills"),
        );
        const fileSystem = yield* FileSystem.FileSystem;
        // Optional entries absent from the shared dir are not fabricated.
        expect(yield* fileSystem.exists(path.join(shadow, "CLAUDE.md"))).toBe(false);
        // A transcript written through the shadow dir lands in the shared dir.
        yield* writeTextFile(path.join(shadow, "projects", "-tmp-repo", "session.jsonl"), "{}\n");
        expect(
          yield* fileSystem.exists(path.join(shared, "projects", "-tmp-repo", "session.jsonl")),
        ).toBe(true);
      }),
    );

    it.effect("is idempotent across repeated materializations", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* makeTempDir("t3code-claude-overlay-");
        const shared = path.join(root, "shared");
        const shadow = path.join(root, "shadow");
        yield* writeTextFile(path.join(shared, "CLAUDE.md"), "# shared\n");

        yield* materializeClaudeShadowHome(overlayLayout(shared, shadow));
        yield* materializeClaudeShadowHome(overlayLayout(shared, shadow));

        expect(yield* readLinkTarget(path.join(shadow, "CLAUDE.md"))).toBe(
          path.join(shared, "CLAUDE.md"),
        );
      }),
    );

    it.effect("retargets a shared symlink that points somewhere else", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeTempDir("t3code-claude-overlay-");
        const shared = path.join(root, "shared");
        const shadow = path.join(root, "shadow");
        const elsewhere = path.join(root, "elsewhere", "projects");
        yield* fileSystem.makeDirectory(elsewhere, { recursive: true });
        yield* fileSystem.makeDirectory(shadow, { recursive: true });
        yield* fileSystem.symlink(elsewhere, path.join(shadow, "projects"));

        yield* materializeClaudeShadowHome(overlayLayout(shared, shadow));

        expect(yield* readLinkTarget(path.join(shadow, "projects"))).toBe(
          path.join(shared, "projects"),
        );
      }),
    );

    it.effect("fails when a shared entry exists in the shadow dir as a real directory", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeTempDir("t3code-claude-overlay-");
        const shared = path.join(root, "shared");
        const shadow = path.join(root, "shadow");
        yield* fileSystem.makeDirectory(path.join(shadow, "projects"), { recursive: true });

        const result = yield* materializeClaudeShadowHome(overlayLayout(shared, shadow)).pipe(
          Effect.flip,
        );

        expect(result).toBeInstanceOf(ClaudeShadowHomeEntryConflictError);
      }),
    );

    it.effect("keeps account-private entries local and removes stale private symlinks", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeTempDir("t3code-claude-overlay-");
        const shared = path.join(root, "shared");
        const shadow = path.join(root, "shadow");
        yield* writeTextFile(path.join(shared, ".credentials.json"), "{}\n");
        yield* writeTextFile(path.join(shared, ".claude.json"), "{}\n");
        yield* fileSystem.makeDirectory(shadow, { recursive: true });
        yield* fileSystem.symlink(
          path.join(shared, ".claude.json"),
          path.join(shadow, ".claude.json"),
        );

        yield* materializeClaudeShadowHome(overlayLayout(shared, shadow));

        // The stale symlink is removed so the CLI recreates a private copy.
        expect(yield* fileSystem.exists(path.join(shadow, ".claude.json"))).toBe(false);
        expect(yield* fileSystem.exists(path.join(shadow, ".credentials.json"))).toBe(false);
      }),
    );

    it.effect("leaves a real private credentials file untouched", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeTempDir("t3code-claude-overlay-");
        const shared = path.join(root, "shared");
        const shadow = path.join(root, "shadow");
        yield* writeTextFile(path.join(shadow, ".credentials.json"), '{"account":"two"}\n');

        yield* materializeClaudeShadowHome(overlayLayout(shared, shadow));

        expect(yield* fileSystem.readFileString(path.join(shadow, ".credentials.json"))).toBe(
          '{"account":"two"}\n',
        );
      }),
    );

    it.effect("adopts a hand-made shadow dir whose symlinks already match", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeTempDir("t3code-claude-overlay-");
        const shared = path.join(root, "shared");
        const shadow = path.join(root, "shadow");
        yield* fileSystem.makeDirectory(path.join(shared, "projects"), { recursive: true });
        yield* writeTextFile(path.join(shared, "settings.json"), "{}\n");
        yield* fileSystem.makeDirectory(shadow, { recursive: true });
        yield* fileSystem.symlink(path.join(shared, "projects"), path.join(shadow, "projects"));
        yield* fileSystem.symlink(
          path.join(shared, "settings.json"),
          path.join(shadow, "settings.json"),
        );
        // Local, non-whitelisted state stays untouched.
        yield* writeTextFile(path.join(shadow, "session-env", "keep.txt"), "local\n");

        yield* materializeClaudeShadowHome(overlayLayout(shared, shadow));

        expect(yield* readLinkTarget(path.join(shadow, "projects"))).toBe(
          path.join(shared, "projects"),
        );
        expect(yield* fileSystem.readFileString(path.join(shadow, "session-env", "keep.txt"))).toBe(
          "local\n",
        );
      }),
    );

    it.effect("rejects a shadow config dir equal to the shared config dir", () =>
      Effect.gen(function* () {
        const shared = yield* makeTempDir("t3code-claude-overlay-");

        const result = yield* materializeClaudeShadowHome(overlayLayout(shared, shared)).pipe(
          Effect.flip,
        );

        expect(result).toBeInstanceOf(ClaudeShadowHomePathConflictError);
      }),
    );

    it.effect("does nothing for a direct layout", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeTempDir("t3code-claude-overlay-");
        const shared = path.join(root, "shared");

        yield* materializeClaudeShadowHome({
          mode: "direct",
          sharedConfigDirPath: shared,
          shadowConfigDirPath: undefined,
        });

        expect(yield* fileSystem.exists(shared)).toBe(false);
      }),
    );
  });
});
