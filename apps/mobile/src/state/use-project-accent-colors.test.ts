import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectAccentColorsFromServerConfigs } from "./project-accent-colors-from-server-configs";

const environmentA = "env-a" as EnvironmentId;
const environmentB = "env-b" as EnvironmentId;

function serverConfig(
  projectAccentColors: ServerConfig["settings"]["projectAccentColors"],
): ServerConfig {
  return { settings: { projectAccentColors } } as ServerConfig;
}

describe("projectAccentColorsFromServerConfigs", () => {
  it("maps every available cached or live server config", () => {
    const serverConfigs = new Map<EnvironmentId, ServerConfig>([
      [environmentA, serverConfig({ "repo:one": "#0055aa" })],
      [environmentB, serverConfig({})],
    ]);

    expect([...projectAccentColorsFromServerConfigs(serverConfigs)]).toEqual([
      [environmentA, { "repo:one": "#0055aa" }],
      [environmentB, {}],
    ]);
  });
});
