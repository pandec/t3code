# PR 45 cy-review

## Target

- Branch: `t3code/claude-usage-source`
- Base: `origin/dev`
- Pull request: https://github.com/pandec/t3code/pull/45
- Diff: `git diff origin/dev...HEAD`
- Date: 2026-07-27
- Round: 1

## Review fleet

This is a stateful, async, cross-client change, so the pass used all three
subagent slots available alongside the executing agent. The UI/Hermes angle
was combined with the adversarial role because the runtime allows four active
agents total.

- Skeptical state reviewer: normalization, merge semantics, identities,
  grouping, selection, and Hermes compatibility.
- Adversarial solution + UI reviewer: end-to-end ownership, mixed-stream
  behavior, API boundaries, React rendering, accessibility, and ring geometry.
- Claude adapter specialist: SDK method semantics, async failure isolation,
  lifecycle blocking, cadence, instance identity, and test fidelity.

All reviewers were instructed to use GPT-5.6 Sol at medium reasoning effort
and to respect the accepted decisions in the review request.

## Summary

- Raw findings: 10
- Kept after deduplication and local verification: 6
- Fix now: 6
- Deferred: 0
- Discarded: 0

## Combined findings

| ID   | File:line                                                                 | Source roles         | Severity | Disposition | Rationale                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------- | -------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-1 | `apps/server/src/provider/Layers/ClaudeAdapter.ts:1858`                   | Adapter, adversarial | HIGH     | Fix now     | The installed SDK method calls `this.request`; extracting and invoking it unbound makes every live pull reject silently.                                          |
| CR-2 | `apps/server/src/provider/Layers/ClaudeAdapter.ts:1863`, `:2182`, `:3836` | Adapter, adversarial | HIGH     | Fix now     | A never-settling control request is awaited before the stream starts and during turn completion, so it can wedge startup, event handling, or teardown.            |
| CR-3 | `packages/client-runtime/src/state/providerUsage.ts:257`                  | State, adversarial   | MEDIUM   | Fix now     | An empty or numberless authoritative `limits` report returns `null`, preventing it from clearing older windows.                                                   |
| CR-4 | `packages/client-runtime/src/state/providerUsage.ts:269`                  | State, adversarial   | MEDIUM   | Fix now     | Structured `session`/`weekly_all` IDs do not match passive `five_hour`/`seven_day` IDs, so interleaved streams can duplicate rows and alerts.                     |
| CR-5 | `packages/client-runtime/src/state/providerUsage.ts:269`                  | State                | MEDIUM   | Fix now     | Multiple scoped entries can share an ID when model labels are absent or repeated; surface/model identity is ignored and the later row overwrites the earlier one. |
| CR-6 | `apps/web/src/components/chat/ContextWindowMeter.tsx:149`                 | Adversarial UI       | MEDIUM   | Fix now     | A provider-only numberless warning or rejection produces `aria-label=""`, leaving the interactive popover unnamed.                                                |

## Deferred candidates

No new candidates. The accepted unknown-reset alert-identity item remains in
`rev/check/PR-37-cy-review-deferred.md` and is outside this pass.

## Discarded summary

No deduplicated candidate was discarded after verification. Duplicate reports
from multiple roles were merged into the findings above.

## Evidence notes

- Installed `@anthropic-ai/claude-agent-sdk` 0.3.170 implements
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` as an instance
  method that calls `this.request({ subtype: "get_usage" })`.
- The SDK control request has no internal response timeout.
- Existing focused tests passed before fixes (4 files, 131 tests), but the fake
  usage method was an arrow closure and therefore could not expose the receiver
  bug.
