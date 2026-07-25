# PR 37 provider usage meter — cy-review

- Branch: `t3code/provider-usage-meter`
- Base: `origin/dev`
- Diff: `git diff origin/dev...HEAD`
- PR: https://github.com/pandec/t3code/pull/37
- Date: 2026-07-25
- Round: 1

## Review fleet

Four reviewers were used because this is a stateful cross-client feature spanning provider protocol ingestion, persisted activities, defensive normalization, notifications, and native/web UI.

| Reviewer                      | Primary responsibility                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Skeptical code reviewer       | Broad correctness, regression risk, server ingestion, sparse provider events, and tests                      |
| Usage-state specialist        | Per-window identity/merge rules, provider mixing, reset expiry, and staleness                                |
| Web alerts/UI specialist      | Alert de-duplication and persistence, React memoization, Base UI Popover parity, and accessibility           |
| Adversarial solution reviewer | Cross-layer ownership, provider-instance boundaries, mobile behavior, and repository completion requirements |

All reviewers were instructed to use Sol at medium effort, inspect the real code, remain read-only, and honor the accepted trade-offs in the review request.

## Summary

- Raw findings: 16
- Kept after verification/deduplication: 11
- Proposed fix-now: 10
- Deferred candidates: 1
- Discarded or deduplicated: 5

## Combined findings

| ID  | File:line                                                                                                                                                                                | Source roles                   | Severity | Disposition | Rationale                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `packages/client-runtime/src/state/providerUsage.ts:237`                                                                                                                                 | Usage state                    | MEDIUM   | fix now     | Codex quota identity includes `primary`/`secondary`, so a weekly-only primary window duplicates when it later moves to secondary beside a 5h primary window.                                                                     |
| F2  | `packages/client-runtime/src/state/providerUsage.ts:373`                                                                                                                                 | Usage state                    | MEDIUM   | fix now     | `constrainedWindow` compares only percentages, allowing a numeric OK row to outrank the numberless warning row that caused the snapshot warning.                                                                                 |
| F3  | `packages/client-runtime/src/state/providerUsage.ts:324-364`                                                                                                                             | Usage state, skeptical         | MEDIUM   | fix now     | Merged windows lose their own activity timestamps; a fresh window can keep another reset-less window alive beyond the 24-hour freshness limit.                                                                                   |
| F4  | `apps/web/src/components/chat/ChatComposer.tsx:968`; `apps/mobile/src/features/threads/ThreadComposer.tsx:351`                                                                           | Web/UI, skeptical, adversarial | MEDIUM   | fix now     | `Date.now()` is frozen inside memos with no clock dependency, so reset and staleness expiry do not invalidate an idle meter or mobile reset copy.                                                                                |
| F5  | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:616`; `packages/client-runtime/src/state/providerUsage.ts:318`; `apps/web/src/notifications/providerUsageAlerts.ts:90` | Web/UI, adversarial            | HIGH     | fix now     | Persisted usage activities and alert keys discard `providerInstanceId`, allowing same-driver accounts to mix windows and suppress one another's alerts.                                                                          |
| F6  | `packages/client-runtime/src/state/providerUsage.ts:137-142`; `apps/web/src/components/chat/ProviderUsageMeter.tsx:127-135`; `apps/web/src/notifications/providerUsageAlerts.ts:68-81`   | Web/UI, executing agent        | MEDIUM   | fix now     | Numberless Claude states are turned into claimed percentages/full bars: rejected fabricates 100%, `surpassedThreshold` is treated as utilization, and a numberless warning draws a full bar and says it is already at the limit. |
| F7  | `packages/client-runtime/src/state/providerUsage.ts:409-436`; `apps/web/src/notifications/providerUsageAlerts.ts:89-100`                                                                 | Web/UI                         | LOW      | defer       | When reset metadata appears after an initial unknown-reset alert, the key changes and can re-alert within the same period; exact period identity is unavailable without a product fallback choice.                               |
| F8  | `apps/web/src/notifications/providerUsageAlerts.ts:94-112`; `apps/web/src/notifications/turnCompletion.tsx:75-108`                                                                       | Web/UI                         | MEDIUM   | fix now     | Browser notifications without a thread ref all reuse `turn-completed:test`, so simultaneous window alerts replace one another.                                                                                                   |
| F9  | `packages/client-runtime/src/state/providerUsage.ts:181-250`                                                                                                                             | Skeptical                      | HIGH     | fix now     | The Codex protocol documents sparse rolling updates; identity-less Spark follow-ups can bypass the hardcoded suppression and overwrite the default weekly window unless identity/suppression context is retained.                |
| F10 | `apps/web/src/notifications/providerUsageAlerts.ts:23-49,87-115`                                                                                                                         | Adversarial                    | MEDIUM   | fix now     | Every effect reconstructs de-duplication state only from localStorage, so blocked/failed writes repeat alerts despite the comment claiming in-session fallback.                                                                  |
| F11 | `README.md:10-48`                                                                                                                                                                        | Adversarial                    | LOW      | fix now     | The required “What the fork adds” documentation is missing for this material fork feature.                                                                                                                                       |

## Deferred candidates

| ID  | Reason                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F7  | Missing reset metadata makes exact once-per-reset identity unknowable. A fallback needs an explicit choice between possible duplicate alerts when metadata improves and possible suppression across an unseen reset. |

## Discarded summary

- Four raw findings duplicated F3, F4, or F5 and were merged into those entries.
- The proposal to treat each newest Codex event as a complete authoritative snapshot was discarded. The generated Codex protocol explicitly describes these notifications as sparse rolling updates, and the review request specifically asks for per-window merge scrutiny.
- Base UI Popover usage matches the existing `ContextWindowMeter` trigger, hover, focus, and popup pattern; no separate Popover defect was retained.
- Persisted activity delivery and active-thread-only alert delivery were accepted constraints and were not treated as findings.

## Resolution

- Fixed in this pass: F1-F6 and F8-F11.
- Deferred: F7 only.
- Focused verification: 89 tests passed across client runtime, server ingestion, web notifications, and mobile menu presentation.
- Repository gates: `vp check`, `vp run typecheck`, and `vp run lint:mobile` passed. The mobile lint command reported that optional SwiftLint, ktlint, and detekt binaries are not installed, while its static check completed successfully.
