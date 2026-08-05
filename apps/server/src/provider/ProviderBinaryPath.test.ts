// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { ClaudeDriver } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver } from "./Drivers/CodexDriver.ts";
import { CursorDriver } from "./Drivers/CursorDriver.ts";
import { GrokDriver } from "./Drivers/GrokDriver.ts";
import { HermesDriver } from "./Drivers/HermesDriver.ts";
import { OpenCodeDriver } from "./Drivers/OpenCodeDriver.ts";
import { withExpandedProviderBinaryPath } from "./ProviderBinaryPath.ts";

const defaultConfigFactories: ReadonlyArray<
  readonly [name: string, makeConfig: () => { readonly binaryPath: string }]
> = [
  ["Codex", CodexDriver.defaultConfig],
  ["Claude", ClaudeDriver.defaultConfig],
  ["Cursor", CursorDriver.defaultConfig],
  ["Grok", GrokDriver.defaultConfig],
  ["Hermes", HermesDriver.defaultConfig],
  ["OpenCode", OpenCodeDriver.defaultConfig],
];

describe("withExpandedProviderBinaryPath", () => {
  it("expands the Binary path without mutating or dropping sibling settings", () => {
    const config = {
      binaryPath: "~/.local/bin/provider",
      enabled: true,
      homePath: "~/.provider",
    };

    expect(withExpandedProviderBinaryPath(config)).toEqual({
      ...config,
      binaryPath: NodePath.join(NodeOS.homedir(), ".local/bin/provider"),
    });
    expect(config.binaryPath).toBe("~/.local/bin/provider");
  });

  it.each(defaultConfigFactories)(
    "leaves %s's default Binary path unchanged",
    (_name, makeConfig) => {
      const config = makeConfig();

      expect(withExpandedProviderBinaryPath(config)).toEqual(config);
    },
  );
});
