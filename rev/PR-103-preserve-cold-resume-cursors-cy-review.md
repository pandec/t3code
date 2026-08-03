# PR #103 cy-review — round 1

## Target

- Branch: `t3code/preserve-cold-resume-cursors`
- Base: `origin/dev`
- Pull request: https://github.com/pandec/t3code/pull/103
- Reviewed head: `210090e21b5d937d652033f2b3bce0388fcbd887`
- Diff: `git diff origin/dev...HEAD`
- Pass started: `2026-08-03T07:11:53Z`
- Round: 1

The accepted fail-closed and ownership-boundary trade-offs in the review request were treated as fixed constraints.

## Review fleet

| Reviewer              | Primary responsibility                                                    | Why selected                                                                           |
| --------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Skeptical correctness | Disprove `ProviderService.startSession` classification and failure safety | The change adds a five-state compatibility decision around durable conversation state. |
| Adversarial solution  | Challenge service/reactor/directory boundaries and upgrade paths          | The change spans three ownership layers and persisted state.                           |
| Routing/concurrency   | Trace warm/cold ordering, failure recovery, and rate-limit failover       | Session ownership changes asynchronously across projection and provider binding state. |
| Persistence/tests     | Audit key stamping/backfill/import/fork and regression-test strength      | The safety property depends on durable upgrade data and precise tests.                 |

All reviewers ran read-only with `gpt-5.6-sol` at medium reasoning effort.

## Summary

- Raw findings: 8
- Deduplicated kept findings: 6
- Proposed fix now: 6
- Proposed deferred: 0
- Discarded after reviewer output: 0

## Combined findings

| ID  | File:line                                                            | Source roles                     | Severity | Proposed disposition | Rationale                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------- | -------------------------------- | -------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:655` | routing/concurrency, adversarial | HIGH     | fix now              | A deferred missing-owner rejection can write the desired instance into the projected session before `ProviderService` proves compatibility, leaving projection ownership inconsistent with the durable binding. |
| C2  | `apps/server/src/provider/Layers/ProviderService.ts:830`             | skeptical, adversarial           | HIGH     | fix now              | Exact instance-id equality bypasses a persisted continuation key that can differ after an in-place home/config change, allowing a stale cursor into the wrong continuation store.                               |
| C3  | `apps/server/src/provider/Layers/ProviderService.ts:431`             | persistence/tests                | HIGH     | fix now              | Start/fork re-read the dynamic registry after the adapter operation and can omit or mis-stamp the key if the instance is removed/reconfigured during the operation.                                             |
| C4  | `apps/server/src/sessionImport/SessionImportService.ts:183`          | adversarial                      | MEDIUM   | fix now              | Import deduplication does not use a binding's persisted continuation key when its owner no longer resolves, allowing duplicate import of one native conversation after rename/deletion.                         |
| C5  | `apps/server/src/provider/Layers/ProviderSessionDirectory.ts:140`    | adversarial                      | MEDIUM   | fix now              | An omitted explicit compatibility verdict still preserves state when opaque payload keys match, leaving a second inference authority contrary to the explicit-verdict boundary.                                 |
| C6  | `apps/server/src/provider/Layers/ProviderService.test.ts:1731`       | persistence/tests                | MEDIUM   | fix now              | Tests do not directly pin removed-owner matching-key recovery, removed-owner differing-key rejection, or fork continuation-key stamping.                                                                        |

## Deferred candidates

None proposed in reviewer output.

## Discarded summary

No reviewer findings were discarded before live-code validation. Final dispositions are recorded in the deferred log and implementation diff.

## Compact raw-output appendix

- C1 was independently reported as RC-1 and AS-1.
- C2 was independently reported as SC-1 and AS-2.
- C3 was PT-1; C4 was AS-3; C5 was AS-4; C6 was PT-2.

## Validated final disposition

All six findings were confirmed and fixed in round 1. The implementation now preserves projected ownership until a cold start succeeds, validates persisted continuation identity even when an instance id is unchanged, resolves adapter and routing identity atomically for session lifecycle work, makes the directory's explicit compatibility verdict authoritative, and deduplicates imports through durable continuation keys. Focused regressions cover rejected cold switches, removed-owner matching/differing keys, same-id identity drift across start/recovery/fork, hot-reload snapshot stamping, explicit directory verdicts, fork stamping, and removed-owner import deduplication.

Verification passed:

- `pnpm --filter t3 typecheck`
- `env -u CLAUDE_CONFIG_DIR pnpm --dir apps/server exec vp test run src/provider src/orchestration src/sessionImport/SessionImportService.test.ts` — 81 passed, 2 skipped; 1041 tests passed, 6 skipped
- `pnpm fmt:check`

No items were deferred.
