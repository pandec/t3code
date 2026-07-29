# cy-review pass 3 — terminal accent synchronization review

## Target

- Branch: `t3code/fix-mobile-thread-accent-color`
- Range: `4440507dd..07d97bd38`
- Reviewed head: `07d97bd38b930ab6ca9553dab279adc2b4535049`
- Diff base: `4440507dd7bf0537f1c95cc5a990cc58c582fd28`
- Date: `2026-07-29`
- Round: 3
- PR: none

## Review fleet

Four Sol-medium reviewers covered the terminal range because it contains a new
wire capability, serialized server mutation, browser queueing, React retry
state, and mobile recycler integration.

| Reviewer                      | Primary responsibility                                                   |
| ----------------------------- | ------------------------------------------------------------------------ |
| Atomic contract reviewer      | Patch schema, capability skew, server serialization, and acknowledgement |
| Retry lifecycle reviewer      | StrictMode, timers, partial success, remounts, and client persistence    |
| Queue/Restore/mobile reviewer | Ambiguous writes, defaults routing, and recycler invalidation            |
| Adversarial solution reviewer | Cross-client and cross-environment failure counterexamples               |

## Summary

- Raw findings: 4
- Kept underlying findings: 4
- Fix now: 4
- Deferred: 0
- Discarded: 0

## Combined findings

| ID     | File:line                                                      | Source role          | Severity | Disposition | Rationale                                                                                                                                                   |
| ------ | -------------------------------------------------------------- | -------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACC3-1 | `apps/web/src/hooks/useSettings.ts:136`                        | Retry Lifecycle      | MEDIUM   | fix_now     | Fire-and-forget full client-settings writes are not serialized, so an older migration acknowledgement can persist after a later Restore Defaults write.     |
| ACC3-2 | `packages/client-runtime/src/state/projectAccentColors.ts:262` | Retry Lifecycle      | MEDIUM   | fix_now     | Fill capability is checked before an already-authoritative server color, leaving an old-server legacy key permanently dirty even though no write is needed. |
| ACC3-3 | `apps/web/src/hooks/useProjectAccentColors.ts:150`             | Queue/Restore/Mobile | MEDIUM   | fix_now     | After an ambiguous failed write, an empty rendered map makes Restore's queued clear a no-op even though the server may have committed the prior accent.     |
| ACC3-4 | `apps/web/src/hooks/useSettings.ts:150`                        | Queue/Restore/Mobile | LOW      | fix_now     | Unified settings routing derives server keys from persisted settings, so the patch-only fill operation is silently misclassified as client state.           |

## Deferred candidates

None.

## Fix validation

- ACC3-1 fixed with FIFO client-settings persistence. In-memory snapshots still
  update immediately, while full-snapshot host writes now finish in invocation
  order and continue after a failed predecessor.
- ACC3-2 fixed by consuming an existing authoritative server entry before
  checking whether that server can perform an absent-key fill.
- ACC3-3 fixed by making Restore's server clear unconditional; an empty
  replacement is harmless when the server was already empty and decisive when
  an earlier acknowledgement was lost.
- ACC3-4 fixed by deriving unified server routing keys from
  `ServerSettingsPatch.fields`, which includes patch-only operations.

## Validated safe

- Atomic fill is additive, capability-gated, stripped before persistence, and
  applied inside the production server settings semaphore.
- Replacement-before-fill semantics preserve explicit server colors in either
  serialized request order.
- Successful fill, replacement, and clear operations compose from acknowledged
  maps through one per-environment browser lane.
- StrictMode, unmount/remount, partial success, retry backoff, and missing
  acknowledgement keys retain legacy data without destructive duplication.
- Home `LegendList` invalidates from the exact accent map captured by its row
  renderer; the v2 `FlatList` invalidates through its changed renderer identity.

## Raw-output audit notes

- The atomic contract and adversarial reviewers reported no actionable finding.
- The atomic reviewer independently ran 86 focused tests across four files.
- The reviewed head still allowed the client persistence race after
  consolidating Restore's own writes because migration acknowledgement is an
  independent asynchronous client-settings write.
- A failed RPC result is ambiguous: the server may have committed before the
  response was lost, so a user-requested clear must be sent even when the local
  snapshot is empty.

## Verification

- 116 focused tests passed across eight files, covering the complete accent
  contract/server/runtime/web/mobile test set plus the new persistence and
  unified-routing regressions.
- `vp run typecheck` passed.
- `vp check` passed with zero errors and 11 pre-existing warnings.
- `vp run lint:mobile` passed with Temurin 21 supplied because the inherited
  `JAVA_HOME` points at a removed JDK 17 installation.
