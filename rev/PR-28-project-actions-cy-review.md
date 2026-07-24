# PR #28 cy-review

- PR: https://github.com/pandec/t3code/pull/28
- Branch: `t3code/cli-project-actions`
- Base: `dev`
- Diff base: `888c71eb740a2cbd97522678472afd154e290566`
- Reviewed commit: `0d8ae11bb992cc384ff07f2e59e2c46ba331721d`
- Round: 1
- Started: 2026-07-24T08:01:45Z

## Review fleet

| Reviewer                     | Primary responsibility                                                     |
| ---------------------------- | -------------------------------------------------------------------------- |
| Skeptical code               | Correctness, regressions, CLI wiring, and test gaps                        |
| Adversarial solution         | Challenge API boundaries, complexity, and private-fork fit                 |
| Design and reuse             | Shared ownership, Effect idioms, and maintainability                       |
| Concurrency and CLI contract | Cross-process consistency, live error semantics, and automation guarantees |

Four reviewers were used because this change adds a public CLI surface, moves shared domain logic, and changes the orchestration command contract.

## Summary

- Raw findings: 7
- Kept after deduplication: 5
- Fix now: 5
- Deferred: 0
- Discarded: 0

## Combined findings

| ID   | Severity | File                                        | Sources          | Disposition | Rationale                                                                                                                                                                                                                                                                            |
| ---- | -------- | ------------------------------------------- | ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CR-1 | HIGH     | `apps/server/src/cli/project.ts:219`        | AD-1, CC-1, DR-1 | fix now     | Offline runtimes use process-local snapshots, so the timestamp precondition is not atomic across CLI processes; millisecond timestamps are also not monotonic versions. Require the live serialized server for action mutations and use an exact expected-action-array precondition. |
| CR-2 | MEDIUM   | `apps/server/src/orchestration/http.ts:83`  | SK-1, CC-3       | fix now     | A live stale-action conflict is collapsed into an opaque internal 500, so automation cannot distinguish retryable contention from a server fault. Add a declared conflict response and typed CLI mapping.                                                                            |
| CR-3 | MEDIUM   | `apps/server/src/cli/project.ts:604`        | CC-2             | fix now     | No-op updates skip dispatch and therefore skip the stale precondition. Dispatch the conditional update even when the requested value matches the fetched snapshot, while preserving `action: "unchanged"` output.                                                                    |
| CR-4 | MEDIUM   | `apps/server/src/cli/projectActions.ts:125` | DR-2             | fix now     | The one-setup-action invariant is implemented separately in web and CLI. Move the pure normalization helper into shared project-script logic and consume it from both paths.                                                                                                         |
| CR-5 | MEDIUM   | `apps/server/src/cli/project.ts:536`        | AD-2             | fix now     | Enabling automatic worktree setup clears that flag from another action, but human output and docs do not disclose the side effect. Preserve UI-compatible replacement semantics and report/document the cleared IDs.                                                                 |

## Deferred candidates

None.

## Discarded summary

No material candidate was discarded in this round.

## Resolution

All five retained findings were fixed:

- Action add, update, and remove now require the running server; list remains available offline.
- Mutations carry the exact action array they read, and the server returns a typed `409` conflict
  when that array is stale.
- No-op updates still dispatch the conditional command, preserving the stale-action guard.
- Setup-action normalization is shared by the web UI and CLI.
- Human and JSON output disclose setup actions cleared by replacement.

Verification after fixes:

- `vp test run apps/server/src/bin.test.ts apps/server/src/cli/project.test.ts apps/server/src/cli/projectActions.test.ts apps/server/src/orchestration/decider.projectScripts.test.ts apps/web/src/projectScripts.test.ts packages/contracts/src/orchestration.test.ts`
- `vp check`
- `vp run typecheck`
