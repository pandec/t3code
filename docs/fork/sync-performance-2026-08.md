# Upstream-sync performance analysis — 2026-08-12

Evidence-based review of why `/sync-upstream` runs grew from ~50 to ~80 minutes, what was
changed in response, and the baseline for measuring whether the changes worked.

**Cutover marker:** every sync up to and including `670d8745d` (2026-08-11) ran under the
old process. Syncs after 2026-08-12 run under the adjusted skill. When rerunning this
analysis, split the session population on that boundary.

## Method

- Parsed the top-level Claude/T3 transcripts for this repository (16 recent sessions plus
  3 supplemental older ones), deduplicated by session ID, filtered to genuine
  `sync-upstream` skill invocations.
- Multi-agent workflow: 3 parallel analysis passes (timelines, failure/rework patterns,
  fork-hotspot mapping), 2 adversarial critiques, 1 synthesis, then an independent
  final review that re-verified the load-bearing claims against live Git state.
- Sync completion was separated from follow-up work (TestFlight builds, full audits,
  cleanup, feature PRs) that previously inflated perceived sync duration.

## Findings

### The trend is real, and it is not the tests

Across the 14 consistently parsed completed syncs (179 upstream commits, ~19h total):

- Median sync wall time rose from ~50 min to ~80 min; mean ~81.6 min.
- Median explicit conflict paths rose from ~5 to ~16; total ~151–155 conflict paths
  (content + modify/delete + file-location classes).
- Median agent calls per sync rose from ~1 to ~13.
- The complete gate stack is only ~4–5 min: full suite ~59–92 s, typecheck ~10 s,
  install ~3 s. Verification is not the bottleneck.
- Zero push rejections; the `origin/dev` convergence loop works.

### Decomposition of the 2026-08-11 "1.5 hour" run

Two sessions: 11m24 investigating an unrelated stale untracked file, then 79m18 of
actual sync (20 conflicts, ~95 files):

| Phase                                                                                                            |   Time |
| ---------------------------------------------------------------------------------------------------------------- | -----: |
| Preflight, mirror update, 11 overlap reviewers, user decision                                                    |    ~9m |
| Shared-checkout orchestration collision (agents ran `git reset`, destroyed `MERGE_HEAD` and partial resolutions) |  ~9m52 |
| Exclusive conflict resolution                                                                                    | ~30m27 |
| Initial validation + CLI/ledger audit + final semantic audit                                                     | ~16m35 |
| Three confirmed mobile integration fixes                                                                         |  ~9m49 |
| Revalidation, commit, convergence, push                                                                          |  ~3m15 |

~30 min was legitimate integration work; ~10 min was directly destroyed by shared
Git-state ownership. The final semantic audit found 3 real defects — it cannot be cut.

### Where the time actually goes

1. **Semantic overlap in upstream's highest-churn surfaces** — sidebar/thread actions,
   mobile composer/feed/pagination/native menus, provider lifecycle and liveness,
   project settings, repository identity, usage. Clean textual merges increasingly hide
   behavioral duplication that has to be audited by hand.
2. **Orchestration failures** — reviewers and resolvers sharing one checkout without a
   single merge-state owner or a hard completion barrier; polling agents instead of
   blocking on the batch (~3–4 min waste on broad syncs).
3. **User decisions** (~2.5 h across the measured syncs) — deliberate and valuable,
   kept; only batched instead of serialized.
4. **Environment contamination** — `CLAUDE_CONFIG_DIR` broke `ClaudeHome`/
   `ClaudeSessionFork` tests 9 times across 7 sessions because the skill named the
   bare `vp run test` while the ledger required the env-cleared form; nested
   `.claude/worktrees` polluted root test discovery.
5. **Scope creep after completion** — TestFlight builds, audits, and cleanup ran inside
   the same session and inflated perceived sync time.

Commit count is a poor complexity predictor (a 50-commit sync once took 7 min; an
18-commit sync took ~65 min of agent work). `git merge-tree` predicted all conflict
files accurately in every case tested.

### Fork features: keep all of them

No fork feature earns removal on sync-cost grounds. High-cost clusters (mobile
durability/paging, sidebar/thread actions, provider liveness, project settings,
repository identity, native patches, usage coverage) are all high-value; the standing
strategy of adopting upstream where it supersedes and isolating fork logic behind stable
seams (`forkExtras`, extracted hooks) is working. The legacy old-server pagination
bridge is valid _cleanup_ but not a speed lever — the recurring conflicts come from the
fork's pagination state machine, not the old schema fields.

## Resolutions applied (2026-08-12)

`.agents/skills/sync-upstream/SKILL.md`:

- Reviewers are read-only (Git objects only), launched as one batch the sync blocks on;
  the merge starts only after the whole batch returns. Superseding overlaps are
  presented as one decision batch.
- One merge-state owner from merge start through push. Conflict-resolution delegation
  only on broad merges (~15+ conflicted files), only as disjoint-file editors that never
  stage; owner-only fallback on any unexpected state.
- New post-resolution assertion step (marker scan, `MERGE_HEAD`, root `package.json`,
  migration prefixes) before any validation time is spent.
- Validation reordered: cheap gates → one semantic audit (absorbing the old duplicate
  staged-merge inspection) → fixes → full suite once. Full suite and convergence-loop
  commands corrected to `env -u CLAUDE_CONFIG_DIR vp run test`; focused tests
  standardized on `vp test run --root <package-dir> <test-files>`.
- Phase-boundary timestamps recorded and per-phase durations reported, so future syncs
  are measurable against this baseline. Completion report is delivered before any
  follow-up work starts.

`.agents/skills/sync-upstream/LEDGER.md`:

- README rule upgraded to whole-file `git checkout --ours -- README.md` (verified:
  `main:README.md` and `dev:README.md` share zero non-empty lines), with a manual skim
  of upstream's README diff for anything worth porting.

`scripts/check-upstream-sync.sh` (the "Check Upstream Sync" action):

- Now reports fork-overlap file count, `git merge-tree` predicted conflict paths, and a
  "Broad merge" warning at 15+ predicted conflicts. Replaying the 2026-08-11 refs
  reproduces that merge's 20 conflicts exactly.

## Rejected options — do not re-propose without new evidence

- **Dedicated sync worktree**: the colliding agents shared merge state, not a checkout;
  a new worktree adds install cost and another stale test-discovery target. Ownership +
  barrier is the fix.
- **Reviewer consolidation** (3–4 subsystem reviewers instead of one per watchpoint):
  reviewers already run in parallel; the measured waste was polling, and consolidation
  risks invariant coverage.
- **`git rerere`**: the recurring conflicts are semantic, not textual repeats.
- **Removing fork features to reduce conflict surface**: no candidate passed the
  value-vs-cost test.

## Expected effect and how to verify at rerun

Conservative estimate: ~5–8 min saved on routine syncs, ~15–25 min on broad ones
(~10–25 % of the 69–82 min median), with unchanged gates and review depth.

At the next analysis, compare post-2026-08-12 sessions against this baseline on:
median sync wall time, per-phase durations (now in each sync report), orchestration
waste (any repeated Git-state collision means the ownership rule failed), test-run
retries caused by `CLAUDE_CONFIG_DIR` (should be zero), and whether the preview
script's conflict forecast matched the actual merge.
