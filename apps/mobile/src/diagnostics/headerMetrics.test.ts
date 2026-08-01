import { describe, expect, it } from "@effect/vitest";

import { HeaderDiagnosticMetrics } from "./headerMetrics";

describe("header diagnostic metrics", () => {
  it("returns one aggregate snapshot and resets", () => {
    const metrics = new HeaderDiagnosticMetrics();
    metrics.recordDuration("stabilize", 4.25);
    metrics.recordDuration("stabilize", 2);
    metrics.recordDuration("signature", 3.5);
    metrics.recordSignatureLength(128);
    metrics.recordDecision(false);
    metrics.recordDecision(true);

    expect(metrics.takeSnapshot()).toEqual({
      stabilizeCount: 2,
      stabilizeTotalMs: 6.3,
      stabilizeMaxMs: 4.3,
      signatureCount: 1,
      signatureTotalMs: 3.5,
      signatureMaxMs: 3.5,
      maxSignatureLength: 128,
      setOptionsApplied: 1,
      setOptionsSkipped: 1,
    });
    expect(metrics.takeSnapshot()).toBeNull();
  });
});
