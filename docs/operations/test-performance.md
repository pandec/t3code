# Test performance and memory

Measured findings behind the local test-runner bounds, and the follow-ups that
are still open. The changes themselves — worker caps, `apps/server` file
parallelism, the capability-probe fixture leak — are explained where they live
(`scripts/lib/vitest-shared.ts`, `apps/server/vite.config.ts`) and in the
history of those files; this note carries what the code cannot: the measurement
baseline, the open work, and the footguns.

All numbers are from a 16-core / 14.6 GB Ubuntu host (2026-07-27, Vitest
4.1.9), each run in its own memory-capped cgroup. Peak memory is cgroup
`anon`, not RSS. Re-measure before tuning further; treat these as the shape of
the problem, not as current fact.

## Measured baseline

Per-worker marginal memory cost is far below the module-graph size, because
workers share page cache and prewarmed state:

| project                      | 1 worker                    | 4 workers       | marginal/worker |
| ---------------------------- | --------------------------- | --------------- | --------------- |
| `packages/shared` (39 files) | 290 MB, 7.0 s               | 379 MB, 2.9 s   | ~44 MB          |
| `apps/web` unit (181 files)  | 587 MB, 55.9 s              | 943 MB, 21.7 s  | ~119 MB         |
| `apps/server` (213 files)    | 1118 MB, 143.2 s serialized | 1818 MB, 62.4 s | —               |

Typecheck, for contrast, is where single-process memory actually spikes:
`tsgo --noEmit` peaks at **3.9 GB** for `apps/server` and **2.5 GB** for
`apps/web`. Whole-repo `pnpm typecheck` at its `--concurrency-limit 2` peaked
at 4.8 GB. Decision 2026-07-27: the limit stays at 2; lowering it is a last
resort and would not reduce the single-process floor anyway.

## Footguns

- **`VITEST_MAX_WORKERS` overrides everything.** Vitest applies it after
  config resolution, so it beats project-level `maxWorkers` _and_ silently
  defeats `fileParallelism: false` wherever that is set. Useful as an escape
  hatch; surprising if you expected serialization to survive it.
- **A project with its own `vite.config.ts` does not inherit the root `test`
  block.** That is why every project imports `sharedTestDefaults` explicitly.
  A new workspace project that declares a config and skips the import silently
  runs on Vitest's 5 s default timeouts.
- **`vp run -r test` bails at the first failing project**, so one broken
  package makes the whole-workspace run unable to complete.

## `apps/web` isolation

The fork once ran `apps/web` unit tests with `isolate: false` (21.7 s → ~8 s),
keeping files that use `vi.mock`, fake timers, or `vi.resetModules` in an
isolated project. Upstream later moved every React-rendering test into a
headless-Chromium `browser` project, leaving the `unit` project with plain
logic tests, so the 2026-10-18 sync dropped the split and took upstream's
default isolation. Re-measure before reintroducing it.

## Closed items

- **macOS verification of `apps/server` file parallelism** — done 2026-07-29,
  suite green on macOS.
- **Build times** — deprioritized 2026-07-29: builds are infrequent enough on
  this setup that profiling is not worth it.
- **Vite dev server memory growth** — deprioritized 2026-07-29: the dev server
  is rarely used (packaged builds instead); the earlier "fluctuating
  0.5–2 GB" observation remains unverified.
