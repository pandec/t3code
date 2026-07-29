/**
 * Shared Vitest defaults for every workspace project.
 *
 * A workspace project that declares its own `vite.config.ts` does not inherit
 * the root config's `test` block. That left `apps/desktop` and
 * `packages/client-runtime` on Vitest's 5s default while the rest of the
 * workspace ran with 60s — an accident of config layout rather than a
 * deliberate budget, and the reason those two packages were the first to fail
 * whenever the host was busy. Import these defaults explicitly so every
 * project's budget is chosen rather than inherited by omission.
 *
 * Every Vitest worker loads its own copy of the module graph, so worker count
 * trades memory for wall time. One worker per core multiplied across
 * concurrently running projects exhausts host memory long before it saturates
 * the CPU; when that happened the kernel OOM-killer reaped workers mid-run,
 * which surfaced as `EPIPE` crashes, `Worker exited unexpectedly`, and
 * sub-second tests reported as timing out.
 *
 * The bound below is measured, not guessed. On a 16-core / 14.6GB Linux host
 * the marginal cost is ~44MB per worker for a small package
 * (`packages/shared`) and ~119MB for the largest (`apps/web`), whose peak goes
 * 587MB -> 943MB between one and four workers while its wall time drops
 * 55.9s -> 21.7s. Four is the knee: nearly all the parallelism, still modest
 * memory. Combined with the root `test` script's `--concurrency-limit 3` the
 * worst-case fan-out is ~3.1GB, which leaves room for the editors, browsers,
 * and agent processes a developer machine runs alongside the suite. CI runners
 * are provisioned for the workspace and keep Vitest's default.
 *
 * Override for a single run with `VITEST_MAX_WORKERS`. Vitest applies it after
 * config resolution, so it wins over this value and over `fileParallelism`:
 * `VITEST_MAX_WORKERS=8 pnpm --filter @t3tools/web test`.
 */
const LOCAL_MAX_WORKERS = 4;

export const sharedTestDefaults = {
  hookTimeout: 60_000,
  testTimeout: 60_000,
  ...(process.env.CI ? {} : { maxWorkers: LOCAL_MAX_WORKERS }),
} as const;
