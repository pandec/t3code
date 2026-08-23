# Contribution ledger

States: implementing → preview open → approved → upstream open → merged | closed | parked (30-day stop rule).

## Active

| Bug (upstream-bugs.md)              | Branch                           | Preview                                                   | Upstream                                                                 | State                  | Notes                                                                                                                                                                                 |
| ----------------------------------- | -------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #11 mobile file-preview images      | parked                           | -                                                         | upstream [#7857](https://github.com/pingdotgg/t3code/pull/7857) (theirs) | parked, duplicate      | #7857 (active, updated 2026-08-23) fully covers it, including the Android fallback renderer and file-dir path resolution; the fix arrives via sync when it merges                     |
| #8 Codex parentAgentId via activity | `upstream/codex-parent-agent-id` | [pandec#167](https://github.com/pandec/t3code/pull/167)   | -                                                                        | preview open, reviewed | review added retention parity (parent repeated on all lifecycle rows) and nested-spawn tests; relationship-to-#6416 section in body, maintainer decides at handoff                    |
| #3 WSL update result loss           | `upstream/wsl-update-toast`      | [pandec#168](https://github.com/pandec/t3code/pull/168)   | -                                                                        | preview open, reviewed | narrowed to result delivery after review rejected the first design; #2 (progress duplication) returned to backlog with a review-verdict note in the bugs file; squash before upstream |
| #4-6 SSH shell environment cluster  | issue, not PR                    | [pandec#166](https://github.com/pandec/t3code/issues/166) | -                                                                        | preview open           | novel per dedupe search; cite open #3710, #6042 as related when filing upstream                                                                                                       |

## Backlog

#1 update pill instance dedupe, #7 default-branch fallback edge, #9 duplicate task.started reactivation (verify repro first), #10 fastMode draft migration, #12 settings hydration overwrite (strong candidate: small, deterministic, affects every client setting), #13 parentAgentId workflow conflation (found reviewing pandec#167). #14 and #15 (style items) will not be sent: multi-concern shape that goes stale upstream.

## Done

None yet.

## Measurements

Per upstream PR, record: opened, first bot review, first human touch, outcome date, silent merge or discussed. After three outcomes, compare against the study's expectations (most outcomes within a week) and adjust the recipe.

## Lessons

- 2026-08-23: The first batch ran the dedupe search after implementation had already started. It belongs before any code is written; baked into the recipe as step 2.
- 2026-08-23: In a fork checkout, `gh pr create` and `gh issue create` default to the upstream repo. Always pass `-R` explicitly; upstream PR #4004 (July 2026) was an accidental cross-repo open, self-closed in seconds.
- 2026-08-23: Upstream's review bots, from #4004: CodeRabbit has auto-reviews disabled; macroscopeapp is active and posts an approvability verdict ("Needs human review" with blocking issues). Babysitting means answering macroscope findings.
- 2026-08-23: Review-panel briefs must forbid mutation INCLUDING restores: a "read-only" reviewer saw an implementer's in-progress edits as dirt and reset the worktree to HEAD, wiping live work. A dirty tree during concurrent work is something to report, not clean; reviewers should read committed objects (`git show`) when they need a stable snapshot.
- 2026-08-23: The pre-handoff review panel earns its cost: it caught a design-level rejection (WSL fix froze the toast body and destroyed the multi-env prompt) and a contract violation (parent linkage missing from retained lifecycle rows) that bots or maintainers would otherwise have caught upstream — or worse, missed.
