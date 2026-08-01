import { describe, expect, it } from "@effect/vitest";

import {
  MOBILE_DIAGNOSTICS_MAX_FILE_BYTES,
  serializeMobileDiagnosticEvents,
  shouldRotateMobileDiagnostics,
} from "./persistence";

describe("mobile diagnostic persistence", () => {
  it("serializes one JSON object per line", () => {
    expect(
      serializeMobileDiagnosticEvents([{ t: 10, m: 5, k: "app", d: { state: "active" } }]),
    ).toBe('{"t":10,"m":5,"k":"app","d":{"state":"active"}}\n');
  });

  it("rotates only a non-empty file that would exceed the budget", () => {
    expect(shouldRotateMobileDiagnostics(0, MOBILE_DIAGNOSTICS_MAX_FILE_BYTES + 1)).toBe(false);
    expect(shouldRotateMobileDiagnostics(MOBILE_DIAGNOSTICS_MAX_FILE_BYTES - 10, 10)).toBe(false);
    expect(shouldRotateMobileDiagnostics(MOBILE_DIAGNOSTICS_MAX_FILE_BYTES - 10, 11)).toBe(true);
  });
});
