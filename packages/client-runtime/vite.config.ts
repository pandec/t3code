import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { sharedTestDefaults } from "../../scripts/lib/vitest-shared.ts";

export default defineConfig({
  test: {
    ...sharedTestDefaults,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
