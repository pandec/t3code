import { assert, it } from "@effect/vitest";

import { canReplaceThreadTitle } from "../threadTitles.ts";

it("recognizes default and seeded titles", () => {
  assert.isTrue(canReplaceThreadTitle("New thread"));
  assert.isTrue(canReplaceThreadTitle("Generated seed", "Generated seed"));
  assert.isFalse(canReplaceThreadTitle("Custom title", "Generated seed"));
});
