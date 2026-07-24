# PR #28 cy-review

- PR: https://github.com/pandec/t3code/pull/28
- Branch: `t3code/cli-project-actions`
- Base: `dev`
- Diff base: `888c71eb740a2cbd97522678472afd154e290566`
- Reviewed commit: `86d149fb78e82a39216dbc87669f8a05ffdbf593`
- Round: 2
- Started: 2026-07-24T08:13:00Z

## Review fleet

| Reviewer         | Primary responsibility                                      |
| ---------------- | ----------------------------------------------------------- |
| Correctness      | Regressions, error handling, concurrency, and focused tests |
| CLI and API      | Automation contract, HTTP typing, and live/offline behavior |
| Design and tests | Package boundaries, domain reuse, and regression coverage   |
| Adversarial      | Challenge solution assumptions, compatibility, and scope    |

Four reviewers were used because the first pass changed the concurrency and error contract across
the CLI, orchestration API, server, shared package, and web client.

## Summary

- Raw findings: 8
- Kept after deduplication: 4
- Fix now: 4
- Deferred: 0
- Discarded: 0

## Combined findings

| ID   | Severity | File                                        | Sources                 | Disposition | Rationale                                                                                                                                                                                                                                                                                           |
| ---- | -------- | ------------------------------------------- | ----------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-6 | HIGH     | `apps/web/src/components/ChatView.tsx:2821` | CO-1, API-1, DT-1, AD-1 | fix now     | The web action writer already carries `previousScripts` but does not send the new precondition. A stale UI save can therefore overwrite a successful CLI change. Send `expectedScripts` from the web path and test stale writes.                                                                    |
| CR-7 | HIGH     | `apps/server/src/cli/orchestration.ts:122`  | CO-2, AD-2              | fix now     | The shared one-second HTTP timeout can expire after a mutation is queued while the independent worker later commits it, producing an ambiguous failure and unsafe retry. Keep the short timeout for reads/probes but allow dispatch to wait for its acknowledgement; add delayed-response coverage. |
| CR-8 | HIGH     | `packages/contracts/src/environment.ts:34`  | API-2                   | fix now     | A new CLI can talk to an older server that strips the unknown `expectedScripts` field and accepts the full-array write without the guard. Advertise a conditional-script-update capability and refuse action mutations when the server lacks it.                                                    |
| CR-9 | MEDIUM   | `apps/server/src/orchestration/http.ts:88`  | DT-2                    | fix now     | Tests cover the decider and CLI error mapper separately but not the declared HTTP 409 boundary. Add a live stale-dispatch assertion and verify project scripts remain intact.                                                                                                                       |

## Deferred candidates

None.

## Discarded summary

No material candidate was discarded in this round.

## Resolution

All four retained findings were fixed:

- Web action saves now send the same expected-action snapshot as CLI mutations.
- Live dispatch waits for its acknowledgement; the one-second timeout remains limited to discovery
  and read requests.
- Servers advertise conditional project-script updates, and action mutations refuse older servers
  that omit the capability.
- The live CLI integration test now verifies the serialized HTTP `409` response and confirms the
  stale write is not applied.

Verification after fixes:

- `vp test run apps/server/src/bin.test.ts apps/server/src/cli/project.test.ts apps/server/src/cli/projectActions.test.ts apps/server/src/orchestration/decider.projectScripts.test.ts apps/server/src/environment/ServerEnvironment.test.ts apps/web/src/projectScripts.test.ts packages/contracts/src/orchestration.test.ts`
- `vp check`
- `vp run typecheck`
