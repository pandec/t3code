import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

describe("DEFAULT_KEYBINDINGS", () => {
  it("keeps default shortcuts distinct", () => {
    const identities = DEFAULT_KEYBINDINGS.map((binding) => `${binding.key}|${binding.when ?? ""}`);
    expect(new Set(identities).size).toBe(identities.length);
  });
});
