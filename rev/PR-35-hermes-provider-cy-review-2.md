# PR #35 Hermes provider cy-review — round 2

- Target: `feat/hermes-provider` -> `dev`
- PR: https://github.com/pandec/t3code/pull/35
- Reviewed diff: `origin/dev...HEAD`
- Base commit: `4835c210a275fd563e87fea4c08fff3185b79a55`
- Reviewed commit: `3fdc7459f6cbf47d5edab6e4a2a92483f52c61b9`
- Pass completed: `2026-07-25T06:30:56Z`
- Round: 2

## Review fleet

| Reviewer                  | Primary responsibility                                                  | Why selected                                                               |
| ------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Skeptical correctness     | Failure paths and test blind spots                                      | Round 1 materially changed prompt settlement and cancellation bookkeeping. |
| Adversarial solution      | Challenge ownership and provider boundaries                             | Required adversarial pass for stateful cross-module concurrency changes.   |
| Concurrency and lifecycle | Prompt registration, cancellation, settlement, and service reachability | Hermes depends on overlapping ACP prompts and mid-turn interruption.       |
| Integration and contracts | Authentication, probing, skills, schemas, and registration              | The provider crosses ACP, settings, server, web, and mobile surfaces.      |

All reviewers ran read-only with `gpt-5.6-sol` at medium reasoning effort. Three reviewers ran in parallel under the repository's four-agent ceiling; the integration reviewer started as soon as the first slot became available. The executing agent verified every candidate against the working tree and the installed Hermes Agent 0.19.0 source. The repository-required Claude design pass used Fable at medium effort to propose the smallest coherent shared contracts before implementation.

## Summary

- Raw findings: 7
- Kept findings after verification and deduplication: 6
- Fix now: 6
- Deferred: 0
- Discarded: 0
- Deduplicated raw findings: 1

## Combined findings

| ID    | File:line                                                 | Sources      | Severity | Disposition | Rationale                                                                                                                                                          |
| ----- | --------------------------------------------------------- | ------------ | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CY2-1 | `apps/server/src/provider/Layers/ProviderService.ts:1332` | CON-1        | HIGH     | fix now     | Hermes `sendTurn` waits for terminal ACP settlement, so the outer per-thread service lock prevents production steering and interruption from reaching the adapter. |
| CY2-2 | `apps/server/src/provider/acp/AcpSessionRuntime.ts:787`   | CON-2, ADV-1 | HIGH     | fix now     | Concurrent cancellation snapshots active fibers before its ACP notification and does not prevent a new prompt from registering into the gap.                       |
| CY2-3 | `apps/server/src/provider/Layers/HermesAdapter.ts:1079`   | CON-3, ADV-1 | HIGH     | fix now     | Adapter preparation and runtime prompt registration are separated, so interruption can settle and untombstone a turn before a late prompt launches.                |
| CY2-4 | `apps/server/src/provider/Layers/HermesAdapter.ts:1327`   | CON-4        | MEDIUM   | fix now     | Caller interruption while waiting for the adapter lock can strand a turn tombstone indefinitely.                                                                   |
| CY2-5 | `apps/server/src/provider/Layers/HermesAdapter.ts:1093`   | SK-1         | MEDIUM   | fix now     | Successful prompt bookkeeping uses two interruptible ref writes and can leave a successful RPC classified inconsistently or permanently in flight.                 |
| CY2-6 | `apps/server/src/provider/acp/HermesAcpSupport.ts:52`     | INT-1        | HIGH     | fix now     | Hermes authentication is hard-coded to `openai-codex` instead of the provider method advertised by the installed Hermes runtime.                                   |

## Deferred candidates

No items deferred this run.

## Discarded summary

No validated findings were discarded.

## Design disposition

- Keep `ProviderService` and `ProviderAdapterShape` unchanged. Make Hermes `sendTurn` return after atomic ACP prompt registration and settle the RPC in a scoped background fiber, matching the existing start-result contract.
- Add a Hermes-only `promptStart` handle to `AcpSessionRuntime`; coordinate concurrent prompt registration and cancellation with a barrier while leaving the serialized `prompt` and cancel behavior unchanged.
- Widen ACP auth selection to accept either a fixed method id or a selector over the initialize response. Hermes selects its explicit override or the first advertised method; Cursor and Grok retain fixed string behavior.

## Implementation outcome

- Hermes now registers and starts its prompt atomically, returns the turn-start result immediately, and settles success or failure in an interruptible session-scoped fiber.
- Concurrent ACP cancellation raises a barrier before snapshotting prompt fibers, lowers it only after the cancel notification completes, and cannot strand the barrier when its caller is interrupted.
- Hermes authentication now uses an explicit settings override or the first method advertised by the agent. With no advertised method, ACP authentication is skipped.
- Focused regressions cover production-reachable interruption, same-turn steering, terminal failure projection, caller-interrupted cancellation, auth selection and omission, prompt ordering, tool-card ordering, and the existing Grok/Cursor serialized paths.
