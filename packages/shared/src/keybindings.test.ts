import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

describe("DEFAULT_KEYBINDINGS", () => {
  it("binds archive current thread without colliding with another default", () => {
    expect(DEFAULT_KEYBINDINGS.filter((binding) => binding.command === "thread.archive")).toEqual([
      {
        key: "mod+shift+e",
        command: "thread.archive",
        when: "!terminalFocus",
      },
    ]);

    const identities = DEFAULT_KEYBINDINGS.map((binding) => `${binding.key}|${binding.when ?? ""}`);
    expect(new Set(identities).size).toBe(identities.length);
  });
});
