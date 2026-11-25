import { describe, expect, it } from "vite-plus/test";

import { toStoredSteerGraceWindowMs } from "./extras-settings";

describe("toStoredSteerGraceWindowMs", () => {
  it("snaps to the half-second step the slider moves in", () => {
    expect(toStoredSteerGraceWindowMs(2_499)).toBe(2_500);
    expect(toStoredSteerGraceWindowMs(2_749)).toBe(2_500);
    expect(toStoredSteerGraceWindowMs(2_751)).toBe(3_000);
  });
});
