import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProviderUsageRefreshResult } from "./providerUsage.ts";

const decodeRefreshResult = Schema.decodeUnknownSync(ProviderUsageRefreshResult);

describe("ProviderUsageRefreshResult", () => {
  it("decodes a legacy response that predates refreshedInstanceIds", () => {
    // A newer client may talk to an older server (mobile ships separately from
    // the desktop app). Requiring the field would fail decoding and surface a
    // refresh error even though the refresh itself succeeded.
    const legacy = decodeRefreshResult({
      snapshots: [{ instanceId: "claudeAgent", payload: { any: "shape" }, observedAt: 42 }],
    });
    expect(legacy.refreshedInstanceIds).toBeUndefined();
    expect(legacy.snapshots).toHaveLength(1);
  });

  it("decodes a current response carrying the refreshed instances", () => {
    const current = decodeRefreshResult({
      snapshots: [],
      refreshedInstanceIds: ["claudeAgent", "claudeAgent_cl2"],
    });
    expect(current.refreshedInstanceIds).toEqual(["claudeAgent", "claudeAgent_cl2"]);
  });
});
