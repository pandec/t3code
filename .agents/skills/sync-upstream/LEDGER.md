# Sync Ledger

Working memory for the sync-upstream skill. Record only what changes how a sync is performed: standing decisions, watchpoint triggers, and the full-audit marker. Never record what the code or git history already shows, and never grow this into a fork feature list.

Self-cleaning rules (apply during every sync's ledger update):

- Remove a watchpoint after two consecutive syncs in which its path was untouched by upstream or merged trivially.
- Remove a standing decision when the code it governs no longer exists on `dev`, or upstream ships the change named in its revisit condition (then re-decide with the user).
- Update the audit marker after every full audit or explicit postponement.

## Standing decisions

- **Claude skill picker — keep both layers** (2026-07-24). Fork's `listSkillsForCwd`/`adapter.listSkills` (SDK `reload_skills`, per-thread cwd) is the primary source; upstream's `discoverClaudeSkills` provider-status scan is the fallback. Upstream's scan receives the server's own `ServerConfig.cwd`, so dropping the fork path would lose project-scoped skills. Revisit only if upstream makes discovery per-thread-cwd.
- **Repository identity — deliberate hybrid, do not deduplicate** (2026-07-24). Fork persists identity (migration 035 + write-time enrichment in `OrchestrationEngine.ts`); upstream resolves at query time, and the merged `ProjectionSnapshotQuery.ts` writes resolved values back into the fork's column as a cache with stored-value fallback. Both paths cover cases the other cannot.
- **Event replay bounds — complementary, not duplication** (2026-07-24). Upstream's `SHELL_RESUME_MAX_GAP` bounds shell resume; fork's aggregate-filtered `readEvents` (`ws.ts` thread-detail catch-up) filters per-thread replay at the SQL level. Keep both.
- **Migration numbering** (2026-07-24). Fork owns 034–038; upstream's `ProjectionThreadsSettled` was renumbered to 039 on `dev`. New upstream migrations must be renumbered to sit after the fork block; verify ordering every sync that adds a migration.

## Watchpoints

When the incoming upstream range touches a path below, spawn one targeted sub-agent during the behavioral-overlap review to answer that entry's question (is the fork change still needed / still compatible?). Untouched paths need no check.

| Path                                                              | Question                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/composerTrigger.ts`                          | Do fork `/t3-rename` and `/t3-status` commands still compose with upstream's slash-command changes?                             |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`  | Are fork steering and `titlePinned` still compatible with upstream's interrupt and title-generation flow?                       |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` | Is the repository-identity write-back seam intact (see standing decision)?                                                      |
| `apps/server/src/cli/project.ts`                                  | Does fork CLI automation still align with upstream's project CLI wiring?                                                        |
| `apps/web/src/components/sidebar.tsx`                             | Are the fork resize fixes (no-drag rail, pending-width flush) still needed?                                                     |
| `apps/server/src/provider/*TextGeneration*.ts`                    | Do fork summary/speech generators still coexist with upstream commit-message generation?                                        |
| `apps/server/src/persistence/Migrations/`                         | Migration numbering per standing decision.                                                                                      |
| `apps/mobile/app.config.ts`                                       | Single personal-team validation block; fork custom paid-team extension (`T3CODE_APPLE_TEAM_ID`, `isCustomIosTeamBuild`) intact? |

## Full audit

- Next cross-feature fork-vs-upstream audit due: **2026-08-21**, or sooner if a sync merges an unusually large upstream drop (roughly >100 commits).
- Last run: 2026-07-24 — four-agent sweep of all fork commits; no redundant fork code found.
