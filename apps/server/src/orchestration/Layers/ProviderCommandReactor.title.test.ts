import { assert, it } from "@effect/vitest";

import { canReplaceThreadTitle } from "./ProviderCommandReactor.ts";

it("does not replace a pinned title even when it equals the default sentinel", () => {
  assert.isFalse(canReplaceThreadTitle("New thread", undefined, true));
});

it("preserves existing replacement behavior for unpinned and seeded titles", () => {
  assert.isTrue(canReplaceThreadTitle("New thread"));
  assert.isTrue(canReplaceThreadTitle("Generated seed", "Generated seed"));
  assert.isFalse(canReplaceThreadTitle("Custom title", "Generated seed"));
});
