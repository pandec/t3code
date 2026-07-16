# PR #4 cy-review — session import — round 2

## Target

- Branch: `feat/session-import`
- Base: `origin/dev`
- Diff: `git diff origin/dev...HEAD`
- PR: https://github.com/pandec/t3code/pull/4
- Title: `feat: import external Claude/Codex CLI sessions as conversations`
- Round: 2 (final Codex pass)
- Prior fix commit: `52e8e4e38` (`fix: address session import cy-review findings`)
- Started: 2026-07-16T12:00:00Z
- Compiled: 2026-07-16T12:06:00Z

The review treated every user-provided accepted trade-off as a fixed constraint. Three Sol-medium subagents ran in parallel, the maximum available alongside the accountable executor; the executor supplied the fourth adversarial UI/integration angle directly.

## Fleet

| Reviewer                                       | Primary responsibility                                                                                     | Why selected                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Skeptical correctness reviewer                 | Full-diff regressions, failure paths, and test gaps, especially in `52e8e4e38`                             | The prior fix changed model selection, concurrency, event replay, navigation, and strict resume behavior.          |
| Provider parser/runtime specialist             | Claude/Codex parsing, filesystem boundaries, adapter contracts, and native resume                          | Provider-native persistence and continuation semantics are the feature's highest integration risk.                 |
| Concurrency/data-consistency specialist        | Binding ownership, deduplication, dispatch compensation, projections, and reducer replay                   | The import crosses provider-instance state, persistence, and orchestration transaction boundaries.                 |
| Adversarial UI/integration reviewer (executor) | Dialog lifecycle, query refresh, post-import navigation, RPC/state contracts, and upstream-mergeable scope | This checks whether the corrected end-to-end flow remains predictable without re-litigating accepted architecture. |

## Summary

- Raw reviewer findings: 2
- Deduplicated kept findings: 2
- Fix now: 2
- Deferred candidates: 0
- Discarded: 0

## Combined findings

| ID    | File:line                                                   | Source roles | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ----------------------------------------------------------- | ------------ | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR2-1 | `apps/server/src/sessionImport/SessionImportService.ts:194` | SK-1         | MEDIUM   | fix now     | The round-1 fallback selects the first advertised model before the provider default. Claude's production ordering starts with Fable while its declared default is Sonnet, so unknown/missing transcript models can silently continue on the wrong model even when Sonnet is available. Prefer the declared default when it is advertised, then use the first available instance model. |
| CR2-2 | `apps/server/src/sessionImport/SessionImportService.ts:126` | OC-1         | MEDIUM   | fix now     | Bound native ids are flattened into one global set even though provider instances can have independent homes. Copied profiles can legitimately contain the same native UUID, so importing from one instance currently hides or rejects the distinct session in another; key deduplication by provider instance, preserving legacy default-instance ownership.                          |

## Deferred candidates

None.

## Fix outcome

Both kept findings were fixed. Model fallback now prefers the provider's declared default when that model is advertised by the selected instance, falls back to the instance's first available non-custom/custom model when the default is unavailable, and retains the driver default only for an empty snapshot. Native-session deduplication is now keyed by provider instance; legacy bindings without an explicit instance id are assigned to the default instance identified by their provider name.

Focused regression tests cover production-like Claude ordering with Fable before Sonnet and copied native session ids owned by separate provider instances.

## Verification

- `vp test apps/server/src/sessionImport/SessionImportService.test.ts apps/server/src/provider/Drivers/ClaudeSessionImport.test.ts apps/server/src/provider/Layers/CodexSessionRuntime.test.ts packages/client-runtime/src/state/threadReducer.test.ts apps/server/src/server.test.ts apps/server/src/orchestration/decider.import.test.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts packages/client-runtime/src/state/threads-sync.test.ts` — 193 tests passed.
- `vp check` — passed; nine unrelated pre-existing React warnings remain in `CommandPalette.tsx` and `ChatMarkdown.tsx`.
- `vp run typecheck` — passed.
- `git diff --check` — passed.

## Discarded summary

No candidate finding was discarded. The provider parser/runtime specialist and the direct adversarial UI/integration review found no additional material issues after honoring the accepted trade-offs.

## Raw-output audit notes

- SK: 1 finding (`SK-1`).
- PROV: no findings.
- OC: 1 finding (`OC-1`).
- AD/executor: no findings.
