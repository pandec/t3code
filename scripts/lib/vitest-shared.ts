/**
 * Shared Vitest defaults; projects with their own `vite.config.ts` don't inherit the root `test`
 * block, so import these explicitly. Each worker loads the module graph, and one per core across
 * concurrent projects OOMs the host; 4 is the measured knee. CI keeps Vitest's default. Override
 * a single run with `VITEST_MAX_WORKERS`, which wins over this value and `fileParallelism`.
 */
const LOCAL_MAX_WORKERS = 4;

export const sharedTestDefaults = {
  hookTimeout: 60_000,
  testTimeout: 60_000,
  ...(process.env.CI ? {} : { maxWorkers: LOCAL_MAX_WORKERS }),
} as const;
