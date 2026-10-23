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
- New provider packages and launch paths (including fork launches and client terminals) apply `providerThreadEnvironment` at spawn.
- Fork schema goes only through fork-owned tables and `ForkMigrations`; upstream migrations keep their ids.
- Merge a conflicted `patches/` file in extracted package source, regenerate it against the pristine package, and verify the patch reproduces the merged tree.
- Fork-only native patches (`expo-image-picker`, `expo-modules-core`, `expo-notifications`) merge cleanly but stop applying when upstream bumps the SDK: re-key and regenerate them at the locked version.
- When upstream's lockfile pins packages inside the release-age window, add those exact versions to `minimumReleaseAgeExclude` as upstream does.
- Use `.ts` relative imports in code the mobile app bundles; Metro does not remap `.js` specifiers the way tsc and Vite do.
- Usage parsing is driver-owned (`Drivers/*Usage.ts`, provider `usage.ts`): port fork usage behavior there, keep the global scan mutex (adapt upstream tests that assume concurrent scans), the fork's cache wire format with its legacy decoders, and malformed-line accounting under upstream's byte gate. Upstream bumps its own cache version independently: when both sides reach one version with incompatible formats (v6/v7/v8, decoded by shape), assign a fresh `USAGE_SCAN_CACHE_VERSION` and decode the shared version by shape (v10 since 2026-10-23, after upstream reached v9).
- `ws.ts` builds its handler map (`makeWsRpcHandlers`) and builds the layer (upstream's two-group `toHandlers` split) in separate statements to stay under tsc-rs's TS2589 budget; keep that split when upstream edits the handler block. A TS2589 (or patched-package test failure) seen in only one checkout is stale install state: delete every `node_modules` and run `vp install --frozen-lockfile` before restructuring (`--force` adds other platforms' optional packages, which break mobile license checks).
- Keep the fork's per-capability MCP islands: apply upstream transport options in `makeMcpTransport` and provide stateful shared layers (e.g. `ThreadCommandExecutor`) outside the fresh island layers.
- Storage cleanup defaults `worktreeKeepWhen` to `any-local-files` (fork policy: ignored files such as `.env` stay protected) and keeps the fork's full rechecks (active+archived snapshot, every non-stopped stored session protects); restate upstream tests that count snapshot reads or use `isLive` in those terms rather than adopting upstream's lighter rechecks. Parent→subagent families are removable, but unrelated sharers and `.sp-lab.json` worktrees always keep theirs.
- `withWorkspaceLease` is a non-reentrant permit that canonicalizes asynchronously (needs `FileSystem`/`Path`): never nest it for one path (upstream's whole-startup and rollback leases replace fork inner leases), provide those services where upstream calls it (`withCheckoutLease`), and in tests make a holder signal acquisition and canonicalize through the service's file system.
- Mobile pastes re-encode PNGs as JPEG through upstream's `renderPhoto` edge cap; adapt upstream paste tests that expect PNG output.
- Fork settings secrets (usage-source key, Telegram token) go through `mapSettingsSecrets` in `settingsSecrets.ts` under their existing store names; a sent value wins over a stale redaction flag; the Telegram link code is a client-only redaction in `serverSettings.ts`.
- Mobile home list filters and ordering follow upstream; web keeps the fork's multi-select. Mobile existing-thread drafts carry no model (staged settings), so upstream's draft-model reconciliation stays inert: drop its tests that need a pick on an existing-thread draft.
- Desktop app links (`t3code*://new|threads`) accept only the running build's scheme (`DesktopClerk.openAppLink`) and open threads through `openThreadInActivePane`.
- Upstream comment prunes (`no-low-value-comments`): keep fork code and fork-edited comments, drop only whole comment blocks upstream deleted unchanged, and strip fork section dividers the rule flags; empty `{}` JSX leftovers are upstream's.
- Treat fork-only unused-export findings from `knip:check` as advisory.
- Every `apps/web/src` file must compile under the React Compiler (`reactCompilerCoverage.test.ts`, `t3code/no-manual-memo`): convert fork code like upstream (no `useMemo`/`useCallback`, no render-time ref access, `try/finally` → promise `.finally`), then check the generated output still caches values passed to rows and dnd-kit sensors; fork mobile bailouts go in mobile's `KNOWN_BAILOUTS`.
- React-rendering web tests are `*.browser.test.tsx` (headless Chromium): port fork cases into upstream's browser files. A cold first browser run can fail on Vite's dependency re-optimization; rerun before debugging.
- Verify the SEA executable with official Node 26 (`SEA_NODE_VERSION` in `apps/server/vite.config.ts`); `vp` may select the repository's Node 24.
- Upstream API migrations (e.g. Effect 4.0.4 `crypto.randomUUIDv4()`) skip fork-only call sites, and fork test layers miss services upstream adds to shared layers; typecheck finds both, but grep fork files for the old form first. New upstream tests mock modules without the fork imports reached through them (Labs, saved prompts, router, mobile preferences): extend the mocks, not fork code.
- Upstream Claude tests that interrupt a turn the harness never settles hang on the fork's Stop grace: run `passInterruptSettleGrace` after forking the interrupt.
- Custom Claude models expose the fork's gateway effort ladder, not their declared effort descriptors (`isCustomClaudeCatalogModel` guards uncatalogued-model branches); adapt upstream tests that expect the declared ones.
- Timed snoozes follow upstream's wake rules and settling clears every snooze; the fork owns only "Until it's done" ("Until I wake it" removed 2026-10-20). A user's send resumes a Stop-held queue unless it steers.
- Sidebar status pills rank Failed > Plan Ready > background Working/Monitoring (upstream's Waiting-above-Failed is cyclic with Plan Ready). The route reveal clears whichever fork filter (project multi-select, hidden projects, environments) hides the opened thread.
- Known macOS baseline failures: Antigravity missing-parent `/var` path tests, `build-npm-launcher.test.ts`'s `/private/var` launcher path (fails the scripts task, so `vp run test` stops early: rerun desktop, web, mobile, and server separately), Claude steering replay's now/next mismatch, storage cleanup's expired-artifacts aggregation, SessionWorkspaceFollow's completed-switch restart timeout, CheckpointRollbackService's cleanup-first lock order (intermittent), DesktopLinuxUrlHandler's two-spelling theme icons (case-insensitive APFS), CommandPalette.focus's Ctrl+P file picker (`mod` is Meta), CodexInstallation's `.bunx`/`.shim` launcher cases, and ClaudeSkills' plugin-enablement merge. The desktop smoke test's Electron can ignore its 8s SIGTERM on macOS: kill the spawned Electron child by PID; the result line still prints. Run suites with `ANTHROPIC_BASE_URL` unset. Compare against pre-merge before blaming the merge.

## Watchpoints

When the upstream range touches a path, spawn one reviewer for its question.

- `scripts/build-desktop-artifact.ts`, `apps/desktop/vite.config.ts`: does the Dev flavor still reach runtime identity, helper names, and update suppression?
- `apps/server/src/persistence/Migrations.ts`, `Migrations/**`: are `repairForkMigrationHistory` and full-run `runForkMigrations` still ordered correctly, with renamed upstream migrations mapped in `forkMigrationHistory.ts`?
- `orchestration-v2/ProjectionStore.ts`: do all SQL and in-memory reads preserve custom groups, recent archives, held queues as pending work, and history-page `runStatuses`?
- `pullRequest/PullRequestService.ts`, `project/*Identity*`, `project/ProjectEnrichmentService.ts`: do external writes require a live checkout while reads keep persisted fallback?
- `Adapters/ClaudeAdapterV2.ts`, `claudeHistory*.ts`: are Stop grace, the parent-only cursor, context/history fixes, gateway models, and worktree-follow intact?
- `ProviderSessionManager.ts`, `mcp/**`, adapter MCP injection: does every path respect per-thread capabilities and voice tool timeouts?
- `provider/Drivers/Codex*`, `CodexAdapterV2.ts`, `project/AgentSessionScanner.ts`: do runtime and discovery resolve the Codex home from the same merged environment?
- `apps/server/src/usage/**`, `Drivers/*Usage*`, `provider-*/src/server/usage.ts`, `CursorUsageAccounts.ts`: do fork usage semantics (homes, malformed vs deliberate skips, retained history, Cursor legacy) and the v9 cache survive?
- `apps/server/src/storageCleanup.ts`: do canonical ownership, Stop-held queue, pending archive/move guards and the final removal reservation still wrap removal?
- `patches/`, `patchedDependencies`, Expo SDK bumps: does each fork-carried native patch still apply, remain needed, and match the SDK's exact version?

## Full audit

- Last run 2026-10-09 (all areas); next due: **2026-11-06**. Scope: fork hooks rebuilt in upstream v2 paths, especially lifecycle/worktree ownership, upstream thread actions that bypass split-pane targeting or archive-when-done, and reasoning propagation into voice and client caches.
