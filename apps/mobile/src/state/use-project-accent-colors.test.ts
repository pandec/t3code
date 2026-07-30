import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectAccentColorsFromPresentations } from "./project-accent-color-presentations";

const environmentA = "env-a" as EnvironmentId;
const environmentB = "env-b" as EnvironmentId;

function serverConfig(
  projectAccentColors: ServerConfig["settings"]["projectAccentColors"],
): ServerConfig {
  return { settings: { projectAccentColors } } as ServerConfig;
}

describe("projectAccentColorsFromPresentations", () => {
  it("uses cached server configs while an environment is disconnected", () => {
    const presentations = new Map<EnvironmentId, Pick<EnvironmentPresentation, "serverConfig">>([
      [environmentA, { serverConfig: serverConfig({ "repo:one": "#0055aa" }) }],
      [environmentB, { serverConfig: null }],
    ]);

    expect([...projectAccentColorsFromPresentations(presentations)]).toEqual([
      [environmentA, { "repo:one": "#0055aa" }],
    ]);
  });
});
