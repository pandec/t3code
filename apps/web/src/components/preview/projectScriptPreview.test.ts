import { describe, expect, it } from "vite-plus/test";

import { workspaceServerPreviewUrl } from "./projectScriptPreview";

describe("workspaceServerPreviewUrl", () => {
  it("keeps the configured path on the detected server port", () => {
    expect(
      workspaceServerPreviewUrl(
        "http://localhost:5175",
        "http://localhost:5173/dashboard?tab=1#top",
      ),
    ).toBe("http://localhost:5175/dashboard?tab=1#top");
  });

  it("accepts a bare path", () => {
    expect(workspaceServerPreviewUrl("https://localhost:3001", "/admin")).toBe(
      "https://localhost:3001/admin",
    );
  });
});
