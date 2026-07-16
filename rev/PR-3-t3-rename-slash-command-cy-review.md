# PR #3 cy-review — `/t3-rename` slash command

- Branch: `feat/t3-rename-slash-command`
- Base: `dev`
- Diff base: `origin/dev...HEAD`
- PR: https://github.com/pandec/t3code/pull/3
- Date: 2026-07-16
- Round: 1
- Pass started: 2026-07-16T09:51:00+02:00

## Review fleet

Three reviewers were sufficient for this focused seven-file cross-platform change: the available fleet covered the distinct web, mobile, and shared/design risk surfaces without duplicating a fourth generalist.

- **Skeptical web correctness reviewer** — send-handler ordering, standalone-command preconditions, alternate dispatch paths, async state, and tests.
- **Mobile async/state specialist** — attachment guard, outbox boundary, callback dependencies, draft clearing, autocomplete selection, and Live Activity side effects.
- **Adversarial shared/design reviewer** — parser edge cases, autocomplete contracts, ownership boundaries, reuse, and concrete alternative designs.

All reviewers were instructed to use `gpt-5.6-sol` with medium reasoning effort and to inspect the full frozen diff plus nearby code.

## Summary

- Raw findings: 8
- Combined kept findings: 3
- Fix now: 3
- Deferred: 0
- Discarded: 1 combined candidate

## Combined findings

| ID  | File:line                                                                                             | Source roles                             | Severity | Disposition | Rationale                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | `apps/web/src/components/ChatView.tsx:3889`                                                           | skeptical web, adversarial shared/design | HIGH     | fix_now     | Pending-input and actionable-plan branches run before rename parsing, allowing the local command to become an agent-bound answer or plan follow-up. Move rename interception ahead of every specialized dispatch branch.                                     |
| C2  | `apps/web/src/components/ChatView.tsx:3958`; `apps/mobile/src/state/use-thread-composer-state.ts:168` | all reviewers                            | MEDIUM   | fix_now     | Metadata update is awaited before an unconditional clear, so edits made during the request can be erased. Clear only when the current per-thread draft still matches the submitted rename snapshot; on web, also avoid resetting a newly navigated composer. |
| C3  | `apps/mobile/src/features/threads/ThreadComposer.tsx:519`                                             | mobile async, adversarial shared/design  | MEDIUM   | fix_now     | The lock-screen agent-work activity is armed before the hook can report that a submission was only a local rename or validation failure. Arm only after a real send returns a message id.                                                                    |

## Deferred candidates

None.

## Discarded summary

- One autocomplete-gating proposal was discarded after verification. The attachment/context guards intentionally define whether the exact text is a standalone local command; drafts containing attachments, contexts, or prior text remain ordinary agent messages. The requested web `isServerThread` memo dependency is present, mobile selection correctly falls through to text insertion, and adding cross-component eligibility plumbing would change that product boundary rather than fix a demonstrated defect.

## Raw-output notes

- No shared-parser regex defect was found. Anchoring, command boundaries, trimming, case-insensitive matching, bare-command recognition, and accepted multiline titles behave as intended.
- The mobile send callback dependencies cover its reactive captures.
- Baseline focused tests passed before fixes: 4 files, 74 tests.

## Validation and resolution

- C1 fixed: rename interception now runs before pending-user-input and plan-follow-up dispatch.
- C2 fixed: mobile uses an atomic compare-and-clear helper; web verifies the route, prompt, and context snapshots before clearing and resetting.
- C3 fixed: mobile arms agent awareness only after `onSendMessage` returns a real queued message id.
- Focused tests after fixes: 4 files, 75 tests passed.
- Required checks: `vp check`, `vp run typecheck`, and `vp run lint:mobile` passed. `vp check` retained nine pre-existing warnings in unrelated web components; mobile native lint reported that optional Swift/Kotlin linters are not installed and completed its static checks successfully.
