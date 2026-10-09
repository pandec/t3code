# Sync Ledger

Rules that change how a future sync resolves or verifies a merge, one line each. History lives in PRs, git, and code.

An entry earns its place only if a capable agent with the code in front of it would plausibly get the merge wrong without it. Prefer a test or a code comment beside the code over a new line here. Remove an entry when its code is gone or a test now enforces it; remove a watchpoint after two syncs that left its paths untouched. Keep the file at or under 60 lines: when a new entry would exceed that, make room by merging overlapping entries, tightening wording, or removing entries that code, tests, or upstream now cover.

## Rules

- Resolve `README.md` conflicts with the fork version; port useful upstream text deliberately.
- Take upstream CI (`.github/workflows/ci.yml`) unchanged; run fork-specific verification locally.
- Keep the Release, AUR, and Mobile EAS Production workflows inert while retaining upstream's definitions (`release.yml`, `mobile-eas-production.yml`).
- Keep the Dev DMG artwork and volume title release-style while retaining Dev app identity (`scripts/build-desktop-artifact.ts`).
- Keep the Working beta compiled but default-off, with its web/mobile settings and search entries hidden; ask before exposing it (`useWorkingShelfEnabled`).
- Gate new pane-local keyboard handlers with `isThreadPaneActive` and route thread navigation through `openThreadInActivePane`/`useThreadLinkClick`.
- Provider packages never import `apps/server`: when upstream moves a provider out, move the fork helpers it needs into `packages/provider-core` and take T3 paths from `host.paths`.
- Fork schema goes only through fork-owned tables and `ForkMigrations`; upstream migrations keep their ids.
- When both sides reuse one usage-cache version for incompatible formats, assign a fresh `USAGE_SCAN_CACHE_VERSION` and keep supported legacy decoders.
- Merge a conflicted `patches/` file in extracted package source, regenerate it against the pristine package, and verify the patch reproduces the merged tree.
- Use `.ts` relative imports in code the mobile app bundles; Metro does not remap `.js` specifiers the way tsc and Vite do.
- Treat fork-only unused-export findings from `knip:check` as advisory.
- Verify the SEA executable with official Node 26 (`SEA_NODE_VERSION` in `apps/server/vite.config.ts`); `vp` may select the repository's Node 24.
- Known macOS baseline failures: Antigravity missing-parent `/var` path tests and Claude steering replay's now/next mismatch. Compare against pre-merge before blaming the merge.

## Watchpoints

When the upstream range touches a path, spawn one reviewer for its question.

- `scripts/build-desktop-artifact.ts`, `apps/desktop/vite.config.ts`: does the Dev flavor still reach runtime identity, helper names, and update suppression?
- `apps/server/src/persistence/Migrations.ts`, `Migrations/**`: are `repairForkMigrationHistory` and full-run `runForkMigrations` still ordered correctly, with renamed upstream migrations mapped in `forkMigrationHistory.ts`?
- `orchestration-v2/ProjectionStore.ts`: do all SQL and in-memory reads preserve custom groups, recent archives, held queues as pending work, and history-page `runStatuses`?
- `pullRequest/PullRequestService.ts`, `project/*Identity*`, `project/ProjectEnrichmentService.ts`: do external writes require a live checkout while reads keep persisted fallback?
- `Adapters/ClaudeAdapterV2.ts`, `claudeHistory*.ts`: are Stop grace, the parent-only cursor, context/history fixes, gateway models, and worktree-follow intact?
- `ProviderSessionManager.ts`, `mcp/**`, adapter MCP injection: does every path respect per-thread capabilities and voice tool timeouts?
- `provider/Drivers/Codex*`, `CodexAdapterV2.ts`, `project/AgentSessionScanner.ts`: do runtime and discovery resolve the Codex home from the same merged environment?
- `patches/`, `patchedDependencies`, Expo SDK bumps: does each fork-carried native patch still apply, remain needed, and match the SDK's exact version?

## Full audit

- Next due: **2026-10-16**. Scope: fork hooks rebuilt in upstream v2 paths, especially lifecycle/worktree ownership and reasoning propagation into voice and client caches.
