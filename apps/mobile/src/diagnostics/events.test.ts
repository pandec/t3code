import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { connectionDiagnosticDetails, diagnosticEnvironmentKey } from "./events";

describe("mobile diagnostic events", () => {
  it("sanitizes connection failures", () => {
    const environmentId = EnvironmentId.make("11111111-1111-4111-8111-111111111111");
    const details = connectionDiagnosticDetails(
      environmentId,
      "PrimaryConnectionTarget",
      {
        desired: true,
        network: "online",
        phase: "backoff",
        stage: null,
        attempt: 3,
        generation: 2,
        lastFailure: new ConnectionTransientError({
          reason: "transport",
          detail: "Private Grey Mac at https://secret.example/token=abc disconnected",
          traceId: "trace-123",
        }),
        retryAt: 2_500,
      },
      2_000,
    );
    const serialized = JSON.stringify(details);

    expect(details).toMatchObject({
      env: diagnosticEnvironmentKey(environmentId),
      failure: "ConnectionTransientError",
      reason: "transport",
      retryInMs: 500,
      traceId: "trace-123",
    });
    expect(serialized).not.toContain(environmentId);
    expect(serialized).not.toContain("Grey Mac");
    expect(serialized).not.toContain("secret.example");
    expect(serialized).not.toContain("token=abc");
  });
});
