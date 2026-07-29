# Sync Ledger

Working memory for the sync-upstream skill. Record only what changes how a sync is performed: standing decisions, watchpoint triggers, and the full-audit marker. Never record what the code or git history already shows, and never grow this into a fork feature list.

Self-cleaning rules (apply during every sync's ledger update):

- Remove a watchpoint after two consecutive syncs in which its path was untouched by upstream or merged trivially.
- Remove a standing decision when the code it governs no longer exists on `dev`, or upstream ships the change named in its revisit condition (then re-decide with the user).
- Update the audit marker after every full audit or explicit postponement.

## Standing decisions

- **Claude skill picker — keep both layers** (2026-07-24). Fork's `listSkillsForCwd`/`adapter.listSkills` (SDK `reload_skills`, per-thread cwd) is the primary source; upstream's `discoverClaudeSkills` provider-status scan is the fallback. Upstream's scan receives the server's own `ServerConfig.cwd`, so dropping the fork path would lose project-scoped skills. Revisit only if upstream makes discovery per-thread-cwd.
- **Provider command flow — keep steering and title-pin guards** (2026-07-24). Fork's failed-steer handling preserves the running session and active turn, while ordinary startup failures still use upstream's error transition. `titlePinned` protects explicit CLI titles before and after asynchronous title generation. Both remain compatible with upstream interrupt/title generation. Revisit if upstream distinguishes failed steers itself or persists an equivalent explicit-title pin.
- **Repository identity — deliberate hybrid, do not deduplicate** (2026-07-24). Fork persists identity (migration 035 + write-time enrichment in `OrchestrationEngine.ts`); upstream resolves at query time, and the merged `ProjectionSnapshotQuery.ts` writes resolved values back into the fork's column as a cache with stored-value fallback. Both paths cover cases the other cannot.
- **Event replay bounds — complementary, not duplication** (2026-07-24). Upstream's `SHELL_RESUME_MAX_GAP` bounds shell resume; fork's aggregate-filtered `readEvents` (`ws.ts` thread-detail catch-up) filters per-thread replay at the SQL level. Keep both.
- **Effect beta bumps land on the fork CLI first** (2026-07-28). When upstream bumps the `effect` beta, typecheck the merge before anything else and read the errors bottom-up: one removed combinator in `apps/server/src/cli/` produces a repo-wide cascade of `unknown`-in-requirements errors (85 of them from a single `Schedule.both` removal at beta 78→102) that looks like broad breakage but is not. Fix the concrete API error, then re-typecheck before diagnosing anything else.
- **Beta flags resolve through a hook, never the raw setting** (2026-07-28). Upstream defaults sidebar v2 (web) and thread list v2 (mobile) ON for nightly/dev/preview builds, gated by `sidebarV2ConfiguredByUser` + `useSidebarV2Enabled()` / `useThreadListV2Enabled()`. Any fork code that branches on either flag must call the hook — reading `settings.sidebarV2Enabled` or `preferences.threadListV2Enabled` directly reads "never chosen" as "off" and ignores the build-stage default. Consequence for the fork: dev-flavor builds now start on v2 by default, so fork sidebar work must land in `SidebarV2.tsx`, not only `Sidebar.tsx`.
- **Project-actions dialog footer — fork and upstream buttons coexist** (2026-07-28). `SidebarV2.tsx` footer keeps the fork's `mr-auto` "Archived threads" button leftmost, then upstream's single-member "Remove project", then "Close". Upstream's conditional `sm:justify-between` was dropped as redundant under `mr-auto`. Revisit if upstream restructures that footer again.
- **Migration numbering** (2026-07-24). Fork migration history occupies 033–040; upstream's `ProjectionThreadsSettled` is 039 and `ProjectionThreadsSnoozed` is 041 on `dev`. Never renumber shipped fork migrations. Renumber new upstream migrations after the highest fork ID and verify ordering every sync that adds one. Databases previously migrated on pure upstream IDs 33/34 are not interchangeable with fork databases because the migrator tracks only the latest numeric ID.

## Watchpoints

When the incoming upstream range touches a path below, spawn one targeted sub-agent during the behavioral-overlap review to answer that entry's question (is the fork change still needed / still compatible?). Untouched paths need no check.

| Path                                                           | Question                                                                                                             | Untouched streak |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `apps/server/src/provider/Layers/ProviderService.ts`           | Does the fork's `strandedPriorTurn` input augmentation still wrap upstream's `sendTurn` call?                        | 1                |
| `apps/web/src/components/settings/SettingsPanels.tsx`          | Do the fork's dirty-badge entries still reference settings upstream has not renamed away?                            | 1                |
| `apps/web/src/components/SidebarV2.tsx`                        | Do the fork's multi-project scope, archived-threads entry, provider icons, and compact time labels survive upstream? | 0                |
| `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` | Does the fork's model-filter wiring (`useHomeModelFilterOptions`) still supply upstream's `serverConfigs` consumers? | 0                |

## Full audit

- Next cross-feature fork-vs-upstream audit due: **2026-08-21**, or sooner if a sync merges an unusually large upstream drop (roughly >100 commits).
- Last run: 2026-07-24 — four-agent sweep of all fork commits; no redundant fork code found.
