# PR 71 cy-review

- Target: `t3code/mobile-thread-actions-syncing-indicators` into `dev`
- PR: https://github.com/pandec/t3code/pull/71
- Diff base: `origin/dev`
- Round: 1
- Date: 2026-07-30

## Review fleet

- Skeptical Code Reviewer: correctness, state precedence, menu wiring, and regression coverage.
- Adversarial Solution Reviewer: challenged the chosen title replacement and feature boundaries.
- Native Header and Accessibility Reviewer: iOS title-view updates, sizing, hit targets, and VoiceOver.
- Design and Test Reviewer: ownership, reuse, option freshness, and proportional tests.

Four reviewers were appropriate because the change combines native navigation behavior, asynchronous
connection state, accessibility, and a restored lifecycle action.

## Summary

- Raw findings: 8
- Kept findings after deduplication: 5
- Fix now: 5
- Deferred: 0
- Discarded: 1 unique proposal

## Combined findings

| Finding                                                      | Sources            | Severity | Disposition | Rationale                                                                             |
| ------------------------------------------------------------ | ------------------ | -------- | ----------- | ------------------------------------------------------------------------------------- |
| Version the native title from its full rendered presentation | A11Y-01, DESIGN-01 | Medium   | Fix now     | The long label can remain stable while the spinner/icon state changes.                |
| Resolve mixed reconnecting/error state consistently          | SKEP-01            | Medium   | Fix now     | Aggregate state can contain both; icon and text must not contradict each other.       |
| Bound title text scaling and provide a 44-point target       | A11Y-02, A11Y-03   | Medium   | Fix now     | The fixed title must remain legible and motor-accessible without changing bar height. |
| Share the populated-list predicate                           | DESIGN-02          | Low      | Fix now     | Header and empty-state placement must use the same archived/pending semantics.        |
| Cover V2 menu action composition                             | SKEP-02            | Low      | Fix now     | Archive exposure in active, settled, and legacy variants should be regression-tested. |

## Deferred candidates

None.

## Discarded summary

The adversarial reviewer proposed retaining `Threads` in a two-line title. The user explicitly said the
screen title may be replaced temporarily and rejected a subtitle-like presentation; the tappable status
also retains full detail through accessibility and the Environments destination. No code change is
warranted for that proposal.
