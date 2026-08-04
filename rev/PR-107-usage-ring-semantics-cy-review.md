# PR #107 cy-review — usage ring semantics

## Target

- Branch: `t3code/usage-ring-semantics`
- Base: `origin/dev` at `40dc0f77e06aba163be04e5ecaa8bc11f5d0c5de`
- Reviewed head: `afe7e46316c96c15d3ebc82b2519709610f9ef86`
- Diff: `git diff origin/dev...HEAD`
- PR: https://github.com/pandec/t3code/pull/107
- Date: 2026-08-04
- Round: 1

## Review fleet

Four Sol-medium reviewers were used because this is a cross-client, async, security-sensitive change whose implementing agent terminated before final handoff.

- Skeptical completeness: verify all nine acceptance items and focused regression coverage.
- Adversarial design: challenge ownership, capability modeling, Fable selection, and speculative abstraction/tests.
- Security and concurrency: trace Codex runtime teardown and the gateway's per-origin auth invariants.
- Cross-client completeness: check web/mobile parity, live-versus-selected identity, disabled/cooldown behavior, and documentation.

## Summary

- Raw findings: 8
- Unique findings after deduplication: 7
- Kept: 6
- Fix now: 5
- Deferred: 1
- Discarded: 1

## Combined findings

| ID       | File:line                                                  | Source                  | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------- | ----------------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOC-1    | `README.md:30`                                             | Skeptical, cross-client | LOW      | fix now     | The fork feature description still promises critical alerts and omits the materially changed ring/account behavior.                                                                                                                                                                                 |
| API-1    | `apps/server/src/provider/cliProxyApiUsage.ts:201`         | Adversarial             | HIGH     | fix now     | With both complete env families, the resolver always prefers Anthropic even for a Codex-driver gateway. Pass the driver preference from the registry and keep fallback for incomplete families.                                                                                                     |
| SEC-1    | `apps/server/src/provider/cliProxyApiUsage.ts:490`         | Security                | MEDIUM   | fix now     | Same-origin management probes check the strike ledger before I/O and record after rejection, so concurrent instances can overspend the local budget and trigger the gateway ban.                                                                                                                    |
| SEC-2    | `apps/server/src/provider/cliProxyApiUsage.ts:397`         | Security                | MEDIUM   | fix now     | Concurrent same-origin catalog reads can all send a rejected client key before per-origin suppression is recorded.                                                                                                                                                                                  |
| TEST-1   | `apps/server/src/provider/Layers/CodexAdapter.test.ts:253` | Security                | LOW      | fix now     | Existing tests prove `runtime.close`, but not scoped-resource release during standalone construction failure/interruption.                                                                                                                                                                          |
| DESIGN-1 | `apps/web/src/lib/contextWindow.ts:65`                     | Adversarial             | MEDIUM   | defer       | Opus 4.7/4.8 fixed 1M capacity is duplicated in web and server. Existing option descriptors are dispatch controls and cannot represent fixed capacity without creating a fake option and changing Claude model-id dispatch; use non-interactive capability metadata in a follow-up contract change. |

## Deferred candidates

| ID       | Scope                                                         | Why deferred                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DESIGN-1 | Contracts, shared model helpers, Claude catalog, web resolver | The correct fix is a new non-dispatch capability field, not reusing option descriptors. That cross-cutting contract change is separable from the usage-ring correctness patch and should be designed and tested independently. |

## Discarded summary

- One adversarial Fable-routing challenge was discarded because the implementation follows the explicit contract: headroom is defined as `usedPercent < 100`, unknown usage does not establish headroom, and the featured-account fallback is used only when no available account has known headroom. Changing it to status-based or stop-on-unknown selection would contradict the accepted specification.

## Resolution and verification

- Updated the fork README to document session/weekly semantics, Claude-only Fable-next behavior, disabled/cooldown visibility, fresh-thread Codex reads, and warning-only notifications.
- Made the target resolver prefer the driver-matching env family while retaining the previous incomplete-family fallback.
- Serialized same-origin management probe admission and single-flighted client catalog authentication per origin/key, preserving the separate client and management credentials and ledgers.
- Added concurrent auth-suppression tests plus standalone Codex scope-release coverage for success and construction failure; the pre-existing interruption test still verifies `runtime.close`.
- `env -u CLAUDE_CONFIG_DIR vp test run ...`: 7 files, 142 tests passed.
- `pnpm fmt`: passed.
- `pnpm typecheck`: passed (pre-existing suggestions only).
- `pnpm lint`: passed (pre-existing warnings only, outside the reviewed diff).
