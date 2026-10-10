// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { ClaudeDriver } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver } from "./Drivers/CodexDriver.ts";
import { GrokDriver } from "@t3tools/provider-grok/server";
import { OpenCodeDriver } from "@t3tools/provider-opencode/server";
import { withExpandedProviderBinaryPath } from "@t3tools/provider-core/server/binaryPath";

const defaultConfigFactories: ReadonlyArray<
  readonly [name: string, makeConfig: () => { readonly binaryPath: string }]
> = [
  ["Codex", CodexDriver.defaultConfig],
  ["Claude", ClaudeDriver.defaultConfig],
  ["Grok", GrokDriver.defaultConfig],
  ["OpenCode", OpenCodeDriver.defaultConfig],
];

describe("withExpandedProviderBinaryPath", () => {
  it("expands the Binary path without mutating or dropping sibling settings", () => {
    const config = {
      binaryPath: "~/.local/bin/provider",
      enabled: true,
      homePath: "~/.provider",
    };

    expect(withExpandedProviderBinaryPath(config, NodeOS.homedir())).toEqual({
      ...config,
      binaryPath: NodePath.join(NodeOS.homedir(), ".local/bin/provider"),
    });
    expect(config.binaryPath).toBe("~/.local/bin/provider");
  });

  it.each(defaultConfigFactories)(
    "leaves %s's default Binary path unchanged",
    (_name, makeConfig) => {
      const config = makeConfig();

      expect(withExpandedProviderBinaryPath(config, NodeOS.homedir())).toEqual(config);
    },
  );
});
