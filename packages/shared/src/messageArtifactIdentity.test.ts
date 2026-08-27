import { expect, it } from "vite-plus/test";

import { messageArtifactTextHash } from "./messageArtifactIdentity.ts";

it("hashes UTF-8 message text as lowercase SHA-256", () => {
  expect(messageArtifactTextHash("hello")).toBe(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});
