import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadGroupReplicationTargets } from "./threadGroupSync";

const capable = { threadCustomGroups: true, threadGroupPlacement: true };

function environment(id: string, phase: string, capabilities = capable) {
  return {
    environmentId: id as EnvironmentId,
    connection: { phase },
    serverConfig: { environment: { capabilities } },
  };
}

describe("threadGroupReplicationTargets", () => {
  it("replicates only to connected, capable environments granted settings:write", () => {
    const environments = [
      environment("writable", "connected"),
      environment("read-only", "connected"),
      environment("offline", "disconnected"),
      environment("incapable", "connected", {
        threadCustomGroups: true,
        threadGroupPlacement: false,
      }),
    ];
    const writable = new Set(["writable", "offline", "incapable"] as EnvironmentId[]);
    expect(
      threadGroupReplicationTargets(environments, writable).map((entry) => entry.environmentId),
    ).toEqual(["writable"]);
  });
});
