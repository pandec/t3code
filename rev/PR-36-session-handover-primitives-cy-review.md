# PR #36 cy-review — session handover primitives

- Branch: `feat/session-cli`
- Base: `origin/dev`
- PR: https://github.com/pandec/t3code/pull/36
- Date: 2026-07-25
- Diff base: `4835c210a275fd563e87fea4c08fff3185b79a55`
- Reviewed head: `9b46357c4387681158ca459d3d5b44882a0c0488`
- Round: 1

## Review fleet

| Reviewer                          | Primary responsibility                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Skeptical transcript/CWD reviewer | Malformed JSONL, canonical `effectiveCwd`, old-server capability gating, and regression coverage     |
| HTTP/path security reviewer       | Per-instance provider homes, macOS/Linux placement, HTTP scopes, and wire-error decoding             |
| Git/transport reviewer            | Child-process argument and environment safety, failure bounds, HTTP deadlines, and capability gating |
| Adversarial integration reviewer  | Cross-module ownership and resumability invariants without redesigning the locked API                |

Four reviewers were used because this is substantial stateful functionality spanning CLI parsing, provider storage, Git worktrees, authenticated HTTP, persistence, and orchestration.

## Summary

- Raw findings: 10
- Kept after verification and deduplication: 8
- Fix now: 8
- Deferred: 0
- Discarded/deduplicated: 2

## Combined findings

| ID   | File:line                                                                                                             | Sources      | Severity | Disposition | Rationale                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ------------ | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-1 | `apps/server/src/provider/http.ts:30`                                                                                 | HPS-1        | HIGH     | fix now     | Claude custom `homePath` is a direct `CLAUDE_CONFIG_DIR`, but catalog placement and the import reader append another `.claude`, making custom instances unreadable.           |
| CR-2 | `apps/server/src/cli/session.ts:198`                                                                                  | SCT-1        | HIGH     | fix now     | The lightweight Claude sniffer accepts record shapes rejected by the authoritative parser; placement can then poison all candidate listing for that workspace.                |
| CR-3 | `apps/server/src/cli/session.ts:171`                                                                                  | SCT-2, HPS-2 | MEDIUM   | fix now     | `Date.parse` accepts non-ISO or calendar-normalized values that do not satisfy destination path derivation and can reach a non-null assertion.                                |
| CR-4 | `apps/server/src/cli/session.ts:705`                                                                                  | SCT-3        | HIGH     | fix now     | An existing derived worktree path is canonicalized but not checked for repository or branch identity before provider storage is mutated.                                      |
| CR-5 | `apps/server/src/cli/session.ts:577`; `apps/server/src/sessionImport/SessionImportService.ts:193`                     | GTC-2        | MEDIUM   | fix now     | Inherited repository-scoping Git variables can override the explicit command cwd on both sides of validation.                                                                 |
| CR-6 | `apps/server/src/cli/session.ts:580`                                                                                  | GTC-1        | MEDIUM   | fix now     | Worktree checkout can invoke hooks/filters but has neither an execution deadline nor an output bound.                                                                         |
| CR-7 | `apps/server/src/cli/session.ts:506`                                                                                  | GTC-3, HPS-3 | LOW      | fix now     | All non-domain HTTP failures are labeled as timeouts, including immediate auth, scope, status, and schema-decode failures.                                                    |
| CR-8 | `apps/server/src/sessionImport/SessionImportService.ts:584`; `apps/server/src/provider/Layers/ProviderService.ts:670` | ADV-1        | HIGH     | fix now     | When worktree metadata persistence warns and continues, the persisted import cwd is later overridden by project-root metadata, so a reported-success handover may not resume. |

## Deferred candidates

No items deferred from triage.

## Discarded summary

- Two reports were duplicate descriptions of the Codex timestamp and HTTP error-classification defects.
- No capability-gating bypass, HTTP scope bypass, shell-quoting injection, or post-validation `workspaceRoot` leak was substantiated.
- The locked HTTP shapes and accepted hard-link, warning, retry, model-option, test-matrix, and worktree-bootstrap trade-offs were not reopened.

## Raw-output audit notes

- SCT: three kept findings; explicitly found no old-server gating defect or canonical-CWD leak after server validation.
- HPS: three findings, two corroborating SCT/GTC; explicitly confirmed read/operate scope enforcement.
- GTC: three kept findings; found argument-vector Git invocation safe from shell quoting injection.
- ADV: one distinct cross-module resumability defect; no additional material challenge to the settled API.
