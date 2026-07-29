import { describe, expect, it } from "vite-plus/test";

import { ACCENT_TINT_ALPHA, ACCENT_TINT_ALPHA_RECEDED, withAccentAlpha } from "./accentTint.ts";

describe("withAccentAlpha", () => {
  it("appends an alpha channel matching web's 12% row tint", () => {
    expect(withAccentAlpha("#0055aa", ACCENT_TINT_ALPHA)).toBe("#0055aa1f");
    expect(withAccentAlpha("#0055AA", ACCENT_TINT_ALPHA_RECEDED)).toBe("#0055AA0f");
  });

  it("pads single-digit alpha bytes so the color stays 8 digits", () => {
    expect(withAccentAlpha("#0055aa", 0.02)).toBe("#0055aa05");
    expect(withAccentAlpha("#0055aa", 0)).toBe("#0055aa00");
    expect(withAccentAlpha("#0055aa", 1)).toBe("#0055aaff");
  });

  it("passes through anything that is not a six-digit hex, rather than blanking a row", () => {
    expect(withAccentAlpha("rebeccapurple", ACCENT_TINT_ALPHA)).toBe("rebeccapurple");
    expect(withAccentAlpha("#0055aaff", ACCENT_TINT_ALPHA)).toBe("#0055aaff");
  });
});
