import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeConfigDirPath,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeConfigDirPath({ homePath: "" })).toBe(
          path.join(resolved, ".claude"),
        );
        // A snapshot, never `process.env` by reference: a live reference
        // would observe the fork driver's temporary CLAUDE_CONFIG_DIR swap.
        const environment = yield* makeClaudeEnvironment({ homePath: "", shadowHomePath: "" });
        expect(environment).not.toBe(process.env);
        expect(environment).toEqual({ ...process.env });
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect(yield* resolveClaudeConfigDirPath({ homePath })).toBe(resolved);
        expect(
          (yield* makeClaudeEnvironment({ homePath, shadowHomePath: "" })).CLAUDE_CONFIG_DIR,
        ).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(
          yield* makeClaudeCapabilitiesCacheKey({
            binaryPath: "claude",
            homePath,
            shadowHomePath: "",
          }),
        ).toBe(`claude\0${resolved}\0\0`);
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "", shadowHomePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("points the CLI at the shadow config dir when one is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolvedShadow = path.resolve(NodeOS.homedir(), ".claude-t3", "personal");

        expect(
          (yield* makeClaudeEnvironment({ homePath: "", shadowHomePath: "~/.claude-t3/personal" }))
            .CLAUDE_CONFIG_DIR,
        ).toBe(resolvedShadow);
        // The shadow dir wins over homePath for the spawned CLI: credentials
        // must come from the account-specific slot.
        expect(
          (yield* makeClaudeEnvironment({
            homePath: "~/.claude",
            shadowHomePath: "~/.claude-t3/personal",
          })).CLAUDE_CONFIG_DIR,
        ).toBe(resolvedShadow);
      }),
    );

    it.effect("keeps shadow instances in the shared config dir's continuation group", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude";
        const resolved = path.resolve(NodeOS.homedir(), ".claude");
        const shadowConfig = { homePath, shadowHomePath: "~/.claude-t3/personal" };

        expect(yield* makeClaudeContinuationGroupKey(shadowConfig)).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeContinuationGroupKey(shadowConfig)).toBe(
          yield* makeClaudeContinuationGroupKey({ homePath }),
        );
      }),
    );

    it.effect("separates capability probes by shadow config dir", () =>
      Effect.gen(function* () {
        const first = yield* makeClaudeCapabilitiesCacheKey({
          binaryPath: "claude",
          homePath: "~/.claude",
          shadowHomePath: "~/.claude-t3/personal",
        });
        const second = yield* makeClaudeCapabilitiesCacheKey({
          binaryPath: "claude",
          homePath: "~/.claude",
          shadowHomePath: "~/.claude-t3/work",
        });
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${path.join(resolved, ".claude")}`,
        );
      }),
    );

    it.effect("uses inherited absolute provider homes for import and continuation identity", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const configDir = path.resolve("/tmp/claude-environment-home");
        const environment = { HOME: "/tmp/user-home", CLAUDE_CONFIG_DIR: configDir };

        expect(yield* resolveClaudeConfigDirPath({ homePath: "" }, environment)).toBe(configDir);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${configDir}`,
        );
      }),
    );

    it.effect("keeps relative config homes grouped without advertising a static path", () =>
      Effect.gen(function* () {
        const environment = { CLAUDE_CONFIG_DIR: ".claude-instance" };
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          "claude:relative-config:.claude-instance",
        );
        expect(
          yield* resolveClaudeConfigDirPath({ homePath: "" }, environment, "/tmp/project"),
        ).toBe("/tmp/project/.claude-instance");
      }),
    );
  });
});
