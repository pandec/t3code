# PR 44 cy-review

- Target: PR #44, `t3code/claude-manual-skill-pointers` into `dev`
- PR: https://github.com/pandec/t3code/pull/44
- Diff: `origin/dev...HEAD`
- Reviewed: 2026-07-27
- Round: 1

## Review fleet

| Reviewer                          | Primary responsibility                                                                 | Reason                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Skeptical token correctness       | Token collection, offsets, splicing, and effort-prefix composition                     | The pure rewrite relies on shared parser offsets plus an EOF sentinel.                   |
| Send-path integration             | Claude send-path coverage, cwd behavior, failure isolation, and persistence boundaries | The rewrite is resolved in the live adapter immediately before SDK message construction. |
| Adversarial security and solution | Prompt-boundary robustness and path provenance                                         | A filesystem path is interpolated into provider-bound prompt text.                       |

## Summary

- Raw findings: 1
- Kept findings: 1
- Fix now: 1
- Deferred: 0
- Discarded: 0

## Combined findings

| ID   | File:line                                                      | Source               | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                                                                                               |
| ---- | -------------------------------------------------------------- | -------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AS-1 | `apps/server/src/provider/Drivers/ClaudeSkillReferences.ts:65` | Adversarial security | MEDIUM   | `fix_now`   | Skill paths come from raw directory entries and are interpolated verbatim. A `]`, line break, or control/format character can escape or visually spoof the `[Read: ...]` pointer, turning a selected workspace skill into immediate prompt injection. Declining unrepresentable paths preserves the literal pointer contract without escaping the real filesystem path. |

## Fix applied

`applyClaudeSkillReferencePointers` now rewrites only paths that can be represented on one
unambiguous line inside the `[Read: ...]` envelope. Paths containing `]`, control characters,
Unicode format controls, or Unicode line/paragraph separators leave the original `$name` unchanged.
The guard does not interpret shell syntax; structurally safe literal paths retain the exact requested
output format.

## Deferred candidates

No items deferred this round.

## Verification before fixes

- `vp test run apps/server/src/provider/Drivers/ClaudeSkillReferences.test.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts`
- Result: 2 files passed, 86 tests passed.

## Verification after fixes

- `vp test run apps/server/src/provider/Drivers/ClaudeSkillReferences.test.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts apps/server/src/provider/Drivers/ClaudeSkills.test.ts`
  - Result: 3 files passed, 103 tests passed.
- `vp check`
  - Result: passed; 0 errors and 10 pre-existing web lint warnings.
- `vp run typecheck`
  - Result: passed; existing Effect suggestions only.
- `git diff --check origin/dev...HEAD`
  - Result: passed.

## Reviewer notes

The token reviewer verified EOF offsets, index-zero cursor handling, mixed resolved and unresolved tokens, non-overlap, Unicode offsets, newlines, tail preservation, and effort-prefix ordering with no material defect. The integration reviewer verified that fresh turns, steering, queued sends, resumed and forked sessions, plan-mode replies, and retries all converge on `sendTurn`; ordinary discovery failures are absorbed; and rewritten text remains confined to the SDK message.
