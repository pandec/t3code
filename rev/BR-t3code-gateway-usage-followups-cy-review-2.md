# cy-review round 2: `t3code/gateway-usage-followups`

- Date: 2026-08-03
- Base: `origin/dev` (`8c29a3756`)
- Head reviewed: `b673e2262`
- Diff: `git diff origin/dev...HEAD`
- Round: 2
- Prior pass: `rev/BR-t3code-gateway-usage-followups-cy-review.md`

## Review fleet

| Reviewer                                 | Primary responsibility                                                                   | Why selected                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Skeptical code reviewer                  | Disprove the round-1 fixes and inspect missing ownership transitions                     | The prior pass changed registry sequencing and health semantics.          |
| Adversarial solution reviewer            | Challenge whether void notifications and token-only ordering can express source identity | Rapid transitions can collapse even when each local operation is correct. |
| Effect concurrency specialist            | Model registry, probe, passive-ingestion, LWW, and single-flight interleavings           | The change composes three independently scheduled paths.                  |
| Design/efficiency/compatibility reviewer | Check unresolved states, hot-path cost, cache bounds, and client compatibility           | The fix added serialized all-instance revalidation to every probe.        |

A required read-only Claude/Fable API pass independently confirmed all five consolidated issues. Its source-key recommendation is adopted with opaque in-memory identity keys and one source/tombstone slot per instance, avoiding management-key storage and preserving the accepted instance-count memory bound.

## Summary

- Raw findings: 7
- Consolidated kept findings: 5
- Fix now: 5
- Deferred: 0
- Discarded: 0

## Combined findings

| ID   | File:line                                                               | Source roles           | Severity | Disposition | Rationale                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------- | ---------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1 | `apps/server/src/provider/Layers/ProviderUsageRefreshLive.ts:295`       | Skeptical, Design      | MEDIUM   | fix now     | Direct to declared-but-unresolved gateway is absent from both resolved-target maps, so it leaves the direct snapshot installed while suppressing every future direct report.                 |
| R2-2 | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1361` | Skeptical, Adversarial | MEDIUM   | fix now     | Passive ingestion allocates its token after the config read, allowing a stale direct event to outrank a gateway-transition tombstone.                                                        |
| R2-3 | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1361` | Concurrency            | MEDIUM   | fix now     | A valid direct report can land before the delayed gateway-to-direct notification drains, then the whole-instance clear deletes the new-source payload.                                       |
| R2-4 | `apps/server/src/provider/Layers/ProviderUsageRefreshLive.ts:327`       | Adversarial            | MEDIUM   | fix now     | Void notifications collapse rapid A-to-direct-to-A history; an intermediate direct report can remain installed because both pulls see A. Source identity must be enforced at the write edge. |
| R2-5 | `apps/server/src/provider/Layers/ProviderUsageRefreshLive.ts:172`       | Concurrency            | MEDIUM   | fix now     | A stale adapter can register after the replacement adapter and overwrite its in-flight entry; stale cleanup then removes tracking while the current probe still runs, admitting duplicates.  |

## Deferred candidates

None.

## Discarded summary

None. Duplicate reports of the unresolved-source and passive-token issues were consolidated above.

## Raw-output appendix

- Skeptical: unresolved declared ownership; passive config-read/token inversion.
- Adversarial: passive token inversion; rapid transition history lost by void pings.
- Effect concurrency: valid direct report erased by delayed clear; reversed in-flight registration orphaning the current probe.
- Design/efficiency/compatibility: unresolved declared ownership; no other material performance, cache, contract, or client findings.

## Resolution

All five findings were fixed in this pass:

- Health state now records an opaque active source key beside independent source and snapshot observation tokens. A source change atomically drops the prior payload, wrong-source writes are rejected, and same-source declarations preserve a newer payload.
- Both passive driver ingestion and gateway reconciliation declare ownership at the write edge. The passive path allocates its token before reading config, while unresolved gateway declarations receive an explicit non-driver source identity.
- Gateway source keys follow the memoized target adapter and rotate when the resolved target disappears or changes; no credentials are retained in health state.
- A late stale adapter now waits for the current single-flight completion and retries instead of replacing the current entry. Join identity includes both adapter and source key.
- Focused tests cover source-gated LWW behavior, unresolved ownership, delayed reconciles preserving a valid direct or replacement payload, and reversed adapter registration.

## Verification

- `pnpm typecheck` — passed
- `pnpm lint` — passed with 12 pre-existing warnings
- `pnpm exec vp check` — passed with the same warnings
- Focused server regression set — 85 passed
- Server package Vitest with `CLAUDE_CONFIG_DIR` unset — 2322 passed, 7 skipped
- Web package Vitest — 1994 passed
- Contracts package Vitest — 271 passed
