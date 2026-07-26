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
 * Every Vitest worker loads its own copy of the module graph (~130MB resident
 * each), so one worker per core multiplied across concurrently running
 * projects exhausts host memory long before it saturates the CPU. When that
 * happened the kernel OOM-killer reaped workers mid-run, which surfaced as
 * `EPIPE` crashes, `Worker exited unexpectedly`, and sub-second tests reported
 * as timing out. Bound the fan-out on developer machines, where the suite
 * competes with editors, browsers, and agent processes for a fixed pool of
 * memory; CI runners are provisioned for the workspace and keep Vitest's
 * default. Raise it for a single package when you want the throughput back:
 * `VITEST_MAX_WORKERS=8 pnpm --filter @t3tools/web test`.
 */
const LOCAL_MAX_WORKERS = 2;

export const sharedTestDefaults = {
  hookTimeout: 60_000,
  testTimeout: 60_000,
  ...(process.env.CI ? {} : { maxWorkers: LOCAL_MAX_WORKERS }),
} as const;
