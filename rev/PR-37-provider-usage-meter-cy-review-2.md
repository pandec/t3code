# PR 37 provider usage meter — cy-review round 2

- Branch: `t3code/provider-usage-meter`
- Base: `origin/dev`
- Diff: `git diff origin/dev...HEAD`
- PR: https://github.com/pandec/t3code/pull/37
- Date: 2026-07-25
- Round: 2

## Review fleet

Four read-only reviewers independently re-reviewed the full branch diff after
round-one fixes.

| Reviewer                      | Primary responsibility                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Skeptical code reviewer       | Broad correctness, server ingestion, ordering, and provider-instance behavior                        |
| Usage-state specialist        | Per-window merging, sparse events, staleness, reset expiry, and alert identity                       |
| Web alerts/UI specialist      | React hooks, alert persistence, cross-environment behavior, Popover parity, and mobile menu wiring   |
| Adversarial solution reviewer | Shared-runtime compatibility, generated Codex protocol semantics, and round-one solution regressions |

All reviewers inspected the actual implementation and prior review artifact,
remained read-only, and were instructed to honor the accepted product
trade-offs in the review request.

## Summary

- Raw findings: 7
- Kept after verification and deduplication: 4
- Fixed now: 4
- Existing deferred candidates: 1
- Discarded or deduplicated: 3

## Combined findings

| ID   | File:line                                                                                                                                                                         | Source roles                   | Severity | Disposition | Rationale                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2F1 | `packages/client-runtime/src/state/providerUsage.ts:133-149,397-417`                                                                                                              | Skeptical, usage state         | MEDIUM   | fix now     | A newer Claude `allowed` event without utilization normalizes to `null`, so it cannot tombstone an older warning for the same window. The stale warning can remain visible and alert until reset or 24-hour expiry.           |
| R2F2 | `packages/client-runtime/src/state/providerUsage.ts:539-546`; `apps/web/src/notifications/providerUsageAlerts.ts:96-130`; `apps/web/src/components/chat/ChatComposer.tsx:969-984` | Skeptical, usage state, web/UI | MEDIUM   | fix now     | Alert keys include a server-local provider-instance slug but not the T3 environment. Shared-origin localStorage can therefore let an alert in one environment suppress a different account's alert in another environment.    |
| R2F3 | `packages/client-runtime/src/state/providerUsage.ts:438-450`                                                                                                                      | Adversarial, executing agent   | MEDIUM   | fix now     | Shared client-runtime calls `Array.prototype.toSorted`, which React Native Hermes does not provide. Mobile imports this derivation path directly and can throw at runtime; `Array.from` already supplies a safe copy to sort. |
| R2F4 | `packages/client-runtime/src/state/providerUsage.ts:218-269,397-430`                                                                                                              | Adversarial, executing agent   | HIGH     | fix now     | Codex recognizes only one of five generated exhaustion enum values, and a later sparse window update can overwrite an exhaustion-critical row. Exhaustion must survive sparse updates for the same reset period.              |

## Existing deferred candidate

The round-one unknown-reset alert identity ambiguity remains valid. A provider
event without `resetsAt` cannot be correlated exactly with a later event that
adds a concrete reset timestamp, so an exact once-per-period rule still needs a
product fallback choice.

## Discarded and deduplicated summary

- The Claude tombstone finding was independently reported twice and merged.
- The environment alert-scope finding was independently reported three times
  and merged.
- The proposal to treat every Codex window-bearing notification as a complete
  replacement snapshot was discarded. The generated Codex schema explicitly
  describes `account/rateLimits/updated` as a sparse rolling update whose
  omitted nullable metadata does not clear prior values. Its same-duration
  collision counterexample is not safely resolvable by deleting omitted
  windows without violating that contract.
- No new issue was retained in persisted activity delivery, React hook
  placement, minute-clock invalidation, Base UI Popover parity, or mobile menu
  wiring.

## Resolution

- Fixed R2F1-R2F4 with focused regression coverage.
- Kept the existing unknown-reset identity item deferred; no new item was
  deferred in round two.
- Focused verification: 102 tests passed across client runtime, server
  ingestion, web notifications, mobile menu presentation, and desktop settings.
- Repository gates: `vp check`, `vp run typecheck`, and
  `vp run lint:mobile` passed. The mobile lint command reported that optional
  SwiftLint, ktlint, and detekt binaries are not installed, while its static
  check completed successfully.
