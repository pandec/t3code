import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ACCENT_TINT_ALPHAS,
  resolveAccentTintAlphas,
  resolveRowAccentTintAlpha,
  withAccentAlpha,
} from "./accentTint.ts";

describe("resolveAccentTintAlphas", () => {
  it("defaults to web's 12% row tint, halved for settled rows", () => {
    expect(DEFAULT_ACCENT_TINT_ALPHAS).toEqual({ alpha: 0.12, recededAlpha: 0.06 });
    expect(resolveAccentTintAlphas(undefined)).toEqual(DEFAULT_ACCENT_TINT_ALPHAS);
  });

  it("keeps the settled tint at half the configured intensity", () => {
    expect(resolveAccentTintAlphas(30)).toEqual({ alpha: 0.3, recededAlpha: 0.15 });
  });

  it("clamps a stored intensity outside the supported range", () => {
    expect(resolveAccentTintAlphas(0).alpha).toBe(0.04);
    expect(resolveAccentTintAlphas(99).alpha).toBe(0.3);
    expect(resolveAccentTintAlphas(Number.NaN)).toEqual(DEFAULT_ACCENT_TINT_ALPHAS);
  });
});

describe("resolveRowAccentTintAlpha", () => {
  const alphas = resolveAccentTintAlphas(20);

  it("paints the configured intensity, halved for a settled row", () => {
    expect(resolveRowAccentTintAlpha({ enabled: true, alphas, receded: false })).toBe(0.2);
    expect(resolveRowAccentTintAlpha({ enabled: true, alphas, receded: true })).toBe(0.1);
  });

  it("paints nothing with tints off, whatever the intensity", () => {
    // The dot is unaffected: it renders the resolved accent directly, and the
    // resolver stays ungated so switching tints off only drops the wash.
    expect(resolveRowAccentTintAlpha({ enabled: false, alphas, receded: false })).toBeNull();
    expect(resolveRowAccentTintAlpha({ enabled: false, alphas, receded: true })).toBeNull();
  });
});

describe("withAccentAlpha", () => {
  it("appends an alpha channel matching web's 12% row tint", () => {
    expect(withAccentAlpha("#0055aa", DEFAULT_ACCENT_TINT_ALPHAS.alpha)).toBe("#0055aa1f");
    expect(withAccentAlpha("#0055AA", DEFAULT_ACCENT_TINT_ALPHAS.recededAlpha)).toBe("#0055AA0f");
  });

  it("pads single-digit alpha bytes so the color stays 8 digits", () => {
    expect(withAccentAlpha("#0055aa", 0.02)).toBe("#0055aa05");
    expect(withAccentAlpha("#0055aa", 0)).toBe("#0055aa00");
    expect(withAccentAlpha("#0055aa", 1)).toBe("#0055aaff");
  });

  it("passes through anything that is not a six-digit hex, rather than blanking a row", () => {
    expect(withAccentAlpha("rebeccapurple", DEFAULT_ACCENT_TINT_ALPHAS.alpha)).toBe(
      "rebeccapurple",
    );
    expect(withAccentAlpha("#0055aaff", DEFAULT_ACCENT_TINT_ALPHAS.alpha)).toBe("#0055aaff");
  });
});
