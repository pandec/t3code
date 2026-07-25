# PR #35 Hermes provider cy-review

- Target: `feat/hermes-provider` -> `dev`
- PR: https://github.com/pandec/t3code/pull/35
- Reviewed diff: `origin/dev...HEAD`
- Base commit: `4835c210a275fd563e87fea4c08fff3185b79a55`
- Reviewed commit: `d06e576c56fa86629585838e943d610a135f1104`
- Pass started: `2026-07-25T05:46:37Z`
- Round: 1

## Review fleet

| Reviewer                   | Primary responsibility                                                | Why selected                                                                |
| -------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Concurrency settlement     | Concurrent prompt settlement, tool-card ordering, cancellation fibers | The change adds overlapping prompt RPCs and multi-prompt turn ownership.    |
| Hermes lifecycle           | Resume/pruning, mode authority, ACP probe lifecycle                   | Hermes session setup has provider-specific failure and notification timing. |
| Adversarial boundaries     | Challenge async ownership and provider boundary assumptions           | Required adversarial pass for a stateful cross-module provider addition.    |
| Contracts and registration | Prompt rewriting, skills parsing, exhaustive registration             | The feature crosses server, contracts, web, and mobile surfaces.            |

All reviewers ran read-only with `gpt-5.6-sol` at medium reasoning effort. The repository's four-agent concurrency ceiling allowed three reviewers at once; the fourth started as soon as a slot became available. The executing agent separately verified every candidate against the working tree and, where relevant, the installed Hermes Agent 0.19.0 source.

## Summary

- Raw findings: 14
- Kept findings after verification and deduplication: 10
- Fix now: 10
- Deferred: 0
- Discarded raw findings: 3
- Deduplicated raw findings: 1

## Combined findings

| ID    | File:line                                               | Sources     | Severity | Disposition | Rationale                                                                                                                                                                                     |
| ----- | ------------------------------------------------------- | ----------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-1  | `apps/server/src/provider/acp/AcpSessionRuntime.ts:708` | CS-1        | HIGH     | fix now     | Forking and active-set registration are separate interruptible steps, so interruption can orphan an untracked prompt fiber.                                                                   |
| CY-2  | `apps/server/src/provider/Layers/HermesAdapter.ts:1137` | CS-2        | HIGH     | fix now     | Final settlement mutates prompt/session state across interruptible yields; interruption can leave a turn without its terminal event.                                                          |
| CY-3  | `apps/server/src/provider/Layers/HermesAdapter.ts:1275` | CS-3        | MEDIUM   | fix now     | Cancelled turn tombstones are never removed after all prompt slots have been consumed.                                                                                                        |
| CY-4  | `apps/server/src/provider/Layers/HermesAdapter.ts:1129` | CS-4        | MEDIUM   | fix now     | Successful prompt records are appended in RPC response order, reversing original/steer causality when the steer resolves first.                                                               |
| CY-5  | `apps/server/src/provider/acp/AcpSessionRuntime.ts:776` | AB-N1       | HIGH     | fix now     | Concurrent cancellation returns before its ACP notification is necessarily written, allowing the next Hermes prompt to overtake it. Serialized providers must retain their existing behavior. |
| CY-6  | `apps/server/src/provider/acp/HermesAcpExtension.ts:55` | AB-N2       | MEDIUM   | fix now     | Open tools synthesized during failed/cancelled turn settlement are incorrectly stamped as successful completions.                                                                             |
| CY-7  | `apps/server/src/provider/Layers/HermesProvider.ts:147` | HL-1, AB-N5 | MEDIUM   | fix now     | Hermes sends commands after the setup response; the probe reads too early and does not isolate updates by root session id.                                                                    |
| CY-8  | `apps/server/src/provider/hermesSkillsSnapshot.ts:42`   | CR-1        | MEDIUM   | fix now     | Snapshot folder names differ from canonical frontmatter invocation names and are deduplicated before Hermes slug normalization.                                                               |
| CY-9  | `apps/server/src/provider/hermesSkillsSnapshot.ts:48`   | CR-2        | MEDIUM   | fix now     | Platform-incompatible and config-disabled skills are advertised as enabled even though Hermes filters them from its active skill set.                                                         |
| CY-10 | `apps/server/src/provider/hermesSkillsSnapshot.ts:57`   | CR-3        | MEDIUM   | fix now     | Skill discovery always reads `~/.hermes`, ignoring the provider instance's merged `HERMES_HOME`.                                                                                              |

## Deferred candidates

No items deferred this run.

## Discarded summary

- The proposed `auto-accept-edits` -> `accept_edits` mapping contradicts the locked plan and explicit requirement that resumed non-full-access sessions reset to `default`.
- Restricting leading `$token` rewrites to a discovered allowlist would change the locked prompt syntax and requires composer/product provenance that is not present in this change.
- The pruned-session false-positive concern does not apply to the current Hermes contract: installed Hermes 0.19.0 returns `models` and `modes` for every live load, including empty histories, while only a missing session returns the empty response detected by the guard.

## Raw-output audit notes

- The installed Hermes ACP server schedules `available_commands_update` with `loop.call_soon` after returning the session setup response.
- The local skills snapshot contains folder/frontmatter identity differences and globally disabled skills, confirming the parser findings against real provider state.
