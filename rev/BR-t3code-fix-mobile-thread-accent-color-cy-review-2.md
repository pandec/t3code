# cy-review pass 2 — post-fix accent synchronization

## Target

- Branch: `t3code/fix-mobile-thread-accent-color`
- Base: `origin/dev`
- Diff: `git diff origin/dev...HEAD`
- Reviewed head: `4440507dd7bf0537f1c95cc5a990cc58c582fd28`
- Diff base: `32360f41dd9e3f2c4399db0ff7603ce807ac5cbe`
- Date: `2026-07-29`
- Round: 2
- PR: none

## Review fleet

Four Sol-medium reviewers independently reviewed the full branch integration,
with primary scrutiny on the fixes introduced by pass 1.

| Reviewer                      | Primary responsibility                                                   |
| ----------------------------- | ------------------------------------------------------------------------ |
| Queue correctness reviewer    | Serialization, failure recovery, stale bases, and clear ordering         |
| Migration specialist          | Acknowledgement, capability skew, retries, and cross-client concurrency  |
| Client integration reviewer   | Connected maps, recycler invalidation, and Restore Defaults              |
| Adversarial solution reviewer | Counterexamples across clients, failures, reconnects, and stale closures |

A required read-only Fable-medium API opinion also assessed the smallest atomic
server contract for migration.

## Summary

- Raw findings: 10
- Kept underlying findings: 5
- Fix now: 5
- Deferred: 0
- Discarded/deduplicated: 5

## Combined findings

| ID     | File:line                                                 | Source roles                  | Severity | Disposition | Rationale                                                                                                                                                      |
| ------ | --------------------------------------------------------- | ----------------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACC2-1 | `apps/web/src/hooks/useProjectAccentColors.ts:190`        | Migration, Adversarial        | HIGH     | fix_now     | A browser-side fill check is not atomic: another client can persist an authoritative color after the snapshot and have migration replace it.                   |
| ACC2-2 | `apps/web/src/hooks/useProjectAccentColors.ts:120`        | All reviewers                 | MEDIUM   | fix_now     | Restore Defaults skips an empty rendered map even when a queued write is about to populate it, so the accent can reappear after reset.                         |
| ACC2-3 | `apps/web/src/hooks/useProjectAccentColors.ts:177`        | Queue, Migration, Adversarial | MEDIUM   | fix_now     | A transient migration failure retains data but does not cause another effect run, stranding the legacy accent until unrelated state changes.                   |
| ACC2-4 | `apps/mobile/src/features/home/HomeScreen.tsx:725`        | Client Integration            | MEDIUM   | fix_now     | The compact Home recycler renders header accents from a closure but omits the map from `extraData`, so settings-only changes can leave recycled headers stale. |
| ACC2-5 | `apps/web/src/components/settings/SettingsPanels.tsx:557` | Adversarial                   | MEDIUM   | fix_now     | Restore Defaults performs two asynchronous whole-client-settings writes; out-of-order persistence can restore stale non-accent settings.                       |

## Validated outcomes

- ACC2-1 fixed with an additive, capability-gated
  `projectAccentColorsFill` patch. The server applies fill-if-absent inside its
  existing settings write semaphore, while explicit picks continue using
  whole-map replacement.
- ACC2-2 fixed by always queueing a clear for every connected writable
  environment; the serialized updater decides whether the latest map is
  already empty.
- ACC2-3 fixed with acknowledged-result retry using capped exponential backoff
  and unmount-safe timer cleanup.
- ACC2-4 fixed by including the compact Home accent map in `LegendList`
  `extraData`.
- ACC2-5 fixed by moving the legacy map reset into the same unified defaults
  patch as every other client setting.
- The per-environment queue correctly composes successful same-client writes
  from the prior acknowledged response, falls back to the live rendered map
  after failure, and cleans up lanes by promise identity.
- Optional capability gating prevents writes to old servers, and connected-only
  maps correctly exclude cached disconnected configurations from writable
  targets.
- Partial migration success consumes only keys confirmed in returned server
  state; failed and unsupported entries remain available for a later migration.
- Deterministic resolution, mobile read-only behavior, canonical-key sharing,
  whole-map replacement for explicit writes, tint cost, and queue cleanup are
  sound.

## Design validation

The Fable-medium API opinion confirmed that migration's fill-if-absent decision
belongs inside the server settings write semaphore. It recommended an additive,
capability-gated `projectAccentColorsFill` patch field whose server semantics
are atomic set-if-absent, while retaining `projectAccentColors` as the explicit
whole-map replacement. A compare-and-set revision would be broader than this
single migration invariant requires.

## Discarded and product-decision summary

- Duplicate reports of the Restore Defaults race and migration retry gap were
  merged into ACC2-2 and ACC2-3.
- Waiting for every Restore Defaults server acknowledgement before closing the
  dialog was not kept as a separate correctness change: the existing settings
  restore path is intentionally command-reporting/fire-and-forget. Queueing the
  clear behind every writable environment closes the data race.
- Cross-client last-writer-wins behavior for explicit whole-map picks remains
  the accepted patch semantic. Only background migration receives atomic
  fill-if-absent behavior.
- Whether cached disconnected accents should remain visible is a product choice;
  this branch intentionally uses connected-only maps and skips disconnected
  writes.

## Raw-output audit notes

- Three reviewers independently reproduced the empty-rendered-map
  write-then-clear race.
- Three reviewers independently reproduced the no-retry-after-failure path.
- Two reviewers independently identified the cross-client migration overwrite.
- The Home recycler finding is the same `extraData` invalidation contract fixed
  for the iPad sidebar in pass 1, on a second mobile entry point.
- The two client-settings writes arise because `clearAll` clears the legacy map
  before `updateSettings` persists the other defaults.

## Verification

- 110 focused tests passed across seven files, including real server-layer
  concurrency, atomic fill semantics, capability decoding, migration planning,
  fill-to-replacement queue chaining, and write-then-clear ordering.
- `vp run typecheck` passed.
- `vp check` passed with zero errors and 11 pre-existing warnings.
- `vp run lint:mobile` passed with Temurin 21 supplied because the inherited
  `JAVA_HOME` points at a removed JDK 17 installation.
