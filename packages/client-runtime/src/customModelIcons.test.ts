import { describe, expect, it } from "vite-plus/test";

import { readCustomModelIcons, reportedModelIcon } from "./customModelIcons.ts";

describe("reportedModelIcon", () => {
  const icons = readCustomModelIcons({ customModelIcons: { "gpt-6-astra": "codex" } });

  it("matches a reported model to its custom-model icon, ignoring an effort suffix", () => {
    expect(reportedModelIcon(icons, "gpt-6-astra")).toBe("codex");
    expect(reportedModelIcon(icons, "gpt-6-astra(high)")).toBe("codex");
  });

  it("returns undefined for unmapped or missing models", () => {
    expect(reportedModelIcon(icons, "claude-opus-5-5")).toBeUndefined();
    expect(reportedModelIcon(icons, null)).toBeUndefined();
  });
});
