# PR #7 cy-review — Composer thread-title commands

## Target

- PR: https://github.com/pandec/t3code/pull/7
- Branch: `feat/rename-prefill-fork-prefix`
- Base: `dev`
- Diff: `git diff origin/dev...HEAD`
- Reviewed head: `f5050bdd1086fb928444fa777e8faf3272cff908`
- Reviewed base: `76f050861952633006e37801fe044f073092c421`
- Date: 2026-07-17
- Round: 1

## Review fleet

Four Sol-medium reviewers were used because the change crosses shared Unicode parsing, web and mobile stateful composer flows, and server orchestration.

| Reviewer                      | Primary responsibility                                                |
| ----------------------------- | --------------------------------------------------------------------- |
| Skeptical flow reviewer       | Disprove web/mobile control-flow correctness and fork-prefix behavior |
| Unicode emoji specialist      | Stress the `u`-flag emoji grammar and leading replacement behavior    |
| Adversarial solution reviewer | Challenge ownership, cross-platform consistency, and test coverage    |
| Cross-platform test reviewer  | Verify mobile/web parity, callback dependencies, and regression tests |

## Summary

- Raw findings: 10
- Unique kept findings: 4
- Fix now: 4
- Deferred: 0
- Discarded as invalid/noise: 0
- Duplicate reports consolidated: 6

## Combined findings

| ID    | File:line                                                | Source roles                           | Severity | Disposition | Rationale                                                                                                                                         |
| ----- | -------------------------------------------------------- | -------------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY7-1 | `packages/shared/src/composerTrigger.ts:152`             | Skeptical, Unicode, Adversarial        | MEDIUM   | fix now     | The repeated selector/modifier arm accepts malformed values such as `👍🏽🏽`, `💡🏽`, and repeated VS16 as one emoji.                               |
| CY7-2 | `packages/shared/src/composerTrigger.ts:152`             | Unicode, Adversarial                   | MEDIUM   | fix now     | RGI subdivision flags are rejected, while leading replacement consumes only the black-flag base and leaves invisible tag characters in the title. |
| CY7-3 | `apps/mobile/src/state/use-thread-composer-state.ts:191` | Adversarial, Cross-platform            | LOW      | fix now     | A failed `/t3-status` metadata update reports rename-specific mobile alert text.                                                                  |
| CY7-4 | `apps/server/src/orchestration/decider.fork.test.ts:98`  | Skeptical, Adversarial, Cross-platform | LOW      | fix now     | The explicit non-stacking `startsWith("🔱 ")` branch is not directly covered by a regression test.                                                |

## Deferred candidates

No deferred candidates.

## Discarded summary

No invalid or style-only findings survived reviewer filtering. Six duplicate reports were consolidated into the four findings above.

## Baseline verification

- `pnpm exec vp test run src/composer-logic.test.ts --project unit` in `apps/web`: 51 passed.
- `pnpm exec vp test run src/orchestration/decider.fork.test.ts` in `apps/server`: 3 passed.
- Package typechecks for `apps/web`, `apps/mobile`, and `apps/server`: passed.

## Resolution

- CY7-1 fixed by restricting each pictographic component to at most one VS16 and one modifier attached to an `Emoji_Modifier_Base`; malformed repetitions and non-base modifiers now fail validation.
- CY7-2 fixed by recognizing the England, Scotland, and Wales RGI subdivision-flag tag sequences as complete emoji graphemes for parsing and leading replacement.
- CY7-3 fixed with status-specific mobile failure text while preserving the prior rename wording.
- CY7-4 fixed with a direct already-prefixed source-title regression test.

## Final verification

- Web composer logic: 51 tests passed.
- Server fork decider: 4 tests passed.
- Mobile package typecheck: passed.
- `vp run typecheck`: passed across all 15 packages.
- Scoped `vp check` for the six changed implementation/test/review files: passed.
- Full `vp check`: blocked only by pre-existing formatting issues in unrelated untracked `.nexus/plans/plan-session-import.md` and `docs/codex-results/20260716-plan-session-import-review.md`; those files were left untouched.
- Installed Hermes compiler accepted the tightened `u`-flag pattern and `Emoji_Modifier_Base` property escape.
