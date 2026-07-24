# PR #28 cy-review

- PR: https://github.com/pandec/t3code/pull/28
- Branch: `t3code/cli-project-actions`
- Base: `dev`
- Diff base: `888c71eb740a2cbd97522678472afd154e290566`
- Reviewed commit: `6812ede59c5edf40317cbf74e3e4a010ae99b826`
- Round: 3
- Started: 2026-07-24T08:25:00Z

## Review fleet

| Reviewer    | Primary responsibility                                            |
| ----------- | ----------------------------------------------------------------- |
| Correctness | Final regression, race, failure-semantics, and coverage audit     |
| CLI and API | Capability negotiation, compatibility, and automation guarantees  |
| Adversarial | Challenge final solution scope, timeout behavior, and assumptions |

Three reviewers were used for this focused follow-up because the preceding broad passes had already
covered domain reuse, UI behavior, and the full CLI surface.

## Summary

- Raw findings: 5
- Kept after deduplication: 3
- Fix now: 3
- Deferred: 0
- Discarded: 0

## Combined findings

| ID    | Severity | File                                                              | Sources | Disposition | Rationale                                                                                                                                                                                                                                                                    |
| ----- | -------- | ----------------------------------------------------------------- | ------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-10 | HIGH     | `apps/server/src/orchestration/decider.ts:558`                    | CO, AD  | fix now     | Capability gating only protected a new CLI from an old server. An old web client could omit the precondition against a new server, and a new web client could send it to an old server that strips it. Reject unguarded script writes and gate the web writer on capability. |
| CR-11 | MEDIUM   | `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:203` | CO, AD  | fix now     | The first stale command returned typed `409`, but replaying the same command ID reconstructed a generic previously-rejected error and returned `500`. Persist and reconstruct the coded rejection so retries preserve the original `409`.                                    |
| CR-12 | MEDIUM   | `apps/server/src/cli/orchestration.ts:133`                        | CO, AD  | fix now     | Waiting forever avoided unsafe retries but could hang automation indefinitely after acknowledgement loss. Use a longer bounded acknowledgement deadline and report an explicit unknown outcome that requires state reconciliation before retrying.                           |

## Deferred candidates

None.

## Discarded summary

No material candidate was discarded in this round.

## Resolution

All three retained findings were fixed:

- The server now requires `expectedScripts` for every script-array mutation, and the web client
  refuses action writes when the connected server lacks the conditional-update capability.
- Coded action conflicts are stored in command receipts and reconstructed on replay, preserving the
  same typed `409` response.
- Live dispatch has a 30-second deadline spanning headers and the complete acknowledgement body.
  Transport loss, malformed success acknowledgements, or deadline expiry report that the outcome is
  unknown and direct callers to inspect current state before retrying. Timeout aborts the transport,
  and malformed completed error responses retain their HTTP status.

Verification after fixes:

- `vp test run apps/server/src/bin.test.ts apps/server/src/cli/project.test.ts apps/server/src/cli/projectActions.test.ts apps/server/src/orchestration/decider.projectScripts.test.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts apps/server/src/environment/ServerEnvironment.test.ts apps/web/src/projectScripts.test.ts packages/contracts/src/orchestration.test.ts`
- `vp check`
- `vp run typecheck`
