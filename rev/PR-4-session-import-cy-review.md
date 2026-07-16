# PR #4 cy-review — session import

## Target

- Branch: `feat/session-import`
- Base: `origin/dev`
- Diff: `git diff origin/dev...HEAD`
- PR: https://github.com/pandec/t3code/pull/4
- Title: `feat: import external Claude/Codex CLI sessions as conversations`
- Round: 1
- Started: 2026-07-16T11:19:00Z
- Compiled: 2026-07-16T11:50:18Z

The review treated the user-provided accepted trade-offs as fixed constraints. The fleet had three parallel reviewers, the maximum available in this run, which is sufficient because each reviewer had a distinct primary surface while retaining permission to inspect the full diff.

## Fleet

| Reviewer                           | Primary responsibility                                                                 | Why selected                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Skeptical service reviewer         | Import transaction ordering, provider-instance/model races, auth, orchestration, tests | The service coordinates persistence, provider state, and event dispatch across failure boundaries. |
| Provider parser/runtime specialist | Claude ancestry/parser safety, Codex app-server lifecycle and strict resume            | Provider-native formats and resume semantics carry the highest integration risk.                   |
| Adversarial UI/event-flow reviewer | Dialog synchronization/navigation and event stream/reducer completeness                | The feature crosses cached client state, live projections, and post-import routing.                |

## Summary

- Raw reviewer findings: 10
- Deduplicated kept findings: 9
- Fix now: 9
- Deferred candidates: 0
- Discarded: 0 (one duplicate event-wiring finding was merged, not discarded)

## Combined findings

| ID   | File:line                                                                             | Source roles | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------- | ------------ | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CR-1 | `apps/server/src/sessionImport/SessionImportService.ts:211`                           | SVC-1        | HIGH     | fix now     | Duplicate requests can pass the non-atomic binding check; the shared deterministic receipt can make the second request report success for a thread never created. A unique per-attempt command id is also required so compensated invariant failures remain retryable.         |
| CR-2 | `apps/server/src/sessionImport/SessionImportService.ts:190`                           | SVC-2        | MEDIUM   | fix now     | Unknown imported models currently fall back to a driver-wide default before considering the instance's advertised models. Prefer a real advertised default/first model, retaining the driver default only when the snapshot has no models.                                     |
| CR-3 | `apps/server/src/sessionImport/SessionImportService.ts:219`                           | SVC-3        | MEDIUM   | fix now     | A slow native read can finish after the selected provider instance was disabled or replaced, persisting resume state against stale instance configuration. Revalidate the exact instance before binding.                                                                       |
| CR-4 | `apps/server/src/ws.ts:256`; `packages/client-runtime/src/state/threadReducer.ts:179` | SVC-4, ADV-1 | MEDIUM   | fix now     | The server's atomic import transaction mitigates the reported current snapshot race, but the public thread-detail live/catch-up contract still drops a state-mutating event and the reducer cannot apply it. Wire it idempotently for complete replay semantics.               |
| CR-5 | `apps/web/src/components/SessionImportDialog.tsx:87`                                  | ADV-2        | MEDIUM   | fix now     | The dialog closes before an invisible fixed poll and later navigates unconditionally, so a timeout can route to `/` and user navigation during the poll can be overwritten. Keep the flow modal, require shell presence before navigation, and report sync timeout explicitly. |
| CR-6 | `apps/server/src/provider/Layers/CodexSessionRuntime.ts:920,1256,1344`                | PROV-1       | MEDIUM   | fix now     | Strict-resume is consumed on first start but dropped from every rebuilt cursor, allowing later restarts to regain fallback-to-new-thread behavior and model override. Preserve the flag in all cursor writes.                                                                  |
| CR-7 | `apps/server/src/provider/Drivers/ClaudeSessionImport.ts:240`                         | PROV-2       | MEDIUM   | fix now     | Real Claude transcripts use `<synthetic>` as an assistant model sentinel; letting it replace the last real model causes resumed sessions to fall back unnecessarily. Ignore the sentinel for model selection while retaining message text.                                     |
| CR-8 | `apps/server/src/provider/Drivers/ClaudeSessionImport.ts:332`                         | PROV-3       | HIGH     | fix now     | The RPC accepts an arbitrary session id which is joined into a transcript path, while only discovery enforces UUID filenames. Validate the same UUID shape before filesystem access to prevent traversal into another project transcript directory.                            |
| CR-9 | `apps/server/src/provider/Layers/CodexAdapter.ts:1794`                                | PROV-4       | HIGH     | fix now     | `thread/read` is global by id and the returned native cwd is never checked against the project-scoped discovery cwd. Canonicalize and compare before exposing/importing history.                                                                                               |

## Deferred candidates

None.

## Fix outcome

All nine kept findings were fixed in round 1. The final patch serializes imports while giving each attempt a retry-safe command id, revalidates provider instances, resolves models from the instance snapshot first, closes the Claude/Codex project-boundary gaps, preserves Codex strict resume, ignores Claude's synthetic model sentinel, completes imported-history replay wiring, and makes post-import navigation explicit on synchronization timeout.

Focused regression coverage was added for concurrent duplicate imports, provider replacement during native reads, model fallback with restricted/empty snapshots, Claude UUID validation and synthetic models, Codex strict cursor preservation, and idempotent imported-history reduction.

## Verification

- `vp test apps/server/src/sessionImport/SessionImportService.test.ts apps/server/src/provider/Drivers/ClaudeSessionImport.test.ts apps/server/src/provider/Layers/CodexSessionRuntime.test.ts packages/client-runtime/src/state/threadReducer.test.ts` — 54 tests passed.
- `vp test apps/server/src/server.test.ts apps/server/src/orchestration/decider.import.test.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts packages/client-runtime/src/state/threads-sync.test.ts` — 137 tests passed.
- `vp check` — passed; nine unrelated pre-existing React warnings remain in `CommandPalette.tsx` and `ChatMarkdown.tsx`.
- `vp run typecheck` — passed.
- `git diff --check` — passed.

## Discarded summary

No unique candidate was discarded. The two independent reports about `thread.history-imported` described the same missing wiring and were merged into CR-4; its timing rationale was narrowed after checking that orchestration persistence and projection occur in one transaction before publication.

## Raw-output audit notes

- SVC: 4 findings (`SVC-1` through `SVC-4`).
- PROV: 4 findings (`PROV-1` through `PROV-4`).
- ADV: 2 findings (`ADV-1` and `ADV-2`).
- Direct verification additionally confirmed that orchestration receipts persist invariant rejections by command id and that local Claude transcripts contain the `<synthetic>` model sentinel.
