# PR 78 cy-review round 2: live multi-account provider usage meter

- Branch: `provider-usage-live`
- Base: `origin/dev` at `23b32ac3d02ae9ef1157dc7ab25b8135703dba00`
- Reviewed head: `7d6582777`
- Prior fix head: `e89b3634b`
- PR: https://github.com/pandec/t3code/pull/78
- Date: 2026-07-30
- Round: 2 of 2
- Diff: `origin/dev...HEAD`

## Baseline integration

The final pass first merged the current `origin/dev` tip into the PR branch. The sole conflict was
`scripts/ios-testflight.ts`; it was resolved with `dev`'s narrower typed fingerprint decoder, which
preserves and supersedes the PR's intentional typecheck fix. `vp run typecheck` and `vp check` passed
before the review fleet started, and merge commit `7d6582777` was pushed.

## Fleet

Three reviewers were used because the four-slot execution limit allows three parallel subagents plus
the accountable primary reviewer.

- Single-flight lifecycle reviewer: map registration, generation replacement, cleanup, interruption,
  failures, re-entry, Deferred completion, and the global semaphore.
- Adversarial boundary reviewer: service/layer ownership, server-wide state sharing, timeout semantics,
  caller disconnects, and post-merge RPC integration.
- Ordering and teardown reviewer: total snapshot order, clock behavior, equal timestamps, Claude
  no-turn construction, timeout, abort, close, and test strength.

All reviewers ran with GPT-5.6 Sol at medium reasoning effort. The boundary reviewer used the
dedicated adversarial role.

## Summary

- Raw findings: 5
- Deduplicated kept findings: 3
- Fix now: 3
- Newly deferred: 0
- Inherited deferred: 1
- Discarded: 1

## Combined findings

| ID    | File:line                                                           | Sources                    | Severity | Disposition | Rationale                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------- | -------------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY2-1 | `apps/server/src/provider/Layers/ProviderUsageRefreshLive.ts:99`    | SINGLE-FLIGHT, ADVERSARIAL | MEDIUM   | fix now     | A replacement instance with the same ID joined the former adapter's probe, so refresh could return without reading the replacement account.                                        |
| CY2-2 | `apps/server/src/provider/Layers/ProviderInstanceHealthLive.ts:176` | ORDERING                   | MEDIUM   | fix now     | Epoch milliseconds are neither a total nor monotonic order; equal-ms arrival could restore stale data and a backward clock adjustment could suppress genuinely newer observations. |
| CY2-3 | `apps/server/src/server.ts:257`                                     | ADVERSARIAL                | LOW      | fix now     | Refresh and RPC reads shared one health Ref only because Effect memoized two appearances of the same layer object; the ownership should be explicit in the dependency graph.       |

## Validated non-findings

- The single-flight cleanup finalizer removes only its own completion entry and always completes its
  Deferred across typed failure, defect, timeout, and interruption. Server-scope shutdown cannot
  permanently wedge joiners or retain the coordinator state.
- The semaphore enforces three provider reads across concurrent RPC calls. Its timeout is deliberately
  per provider probe, so queue wait can make a large refresh take multiple batches; caller-independent
  queued work is intentional because other clients may already be joined to it.
- Claude's ephemeral async generator never yields a user message. Cleanup is idempotent, the 15-second
  bound interrupts the Effect and synchronously aborts and closes the SDK query, and the SDK close path
  terminates its child process and pending transport resources.
- The `origin/dev` merge did not change the read/operate authorization split or make a read-scoped
  caller capable of starting provider work.

## Deferred candidates

The round-one mobile account-email disclosure remains valid and unchanged. No new item was deferred
in round two.

## Discarded summary

- A reviewer proposed a refresh-wide deadline because semaphore queue time is outside the 30-second
  per-probe timeout. This was discarded: the constant and contract bound each provider probe, the
  number of eligible instances is finite, and detached completion is required for server-wide
  single-flight behavior across caller disconnects.

## Resolution

All three fix-now findings were resolved:

- Provider usage writes now carry a server-local monotonic observation token. Epoch milliseconds remain
  raw snapshot metadata for client freshness rendering and no longer decide write order.
- Single-flight entries include adapter identity, so a rebuilt same-ID instance starts a new probe. The
  completion-identity cleanup prevents either generation from deleting the other's entry.
- The runtime layer now provides one structurally shared health service to ingestion, refresh, RPC
  reads, and failover routing without relying on duplicate-layer memoization.

The API shape received the repository-required read-only Claude Fable design pass at medium effort.
It confirmed the separate ordering-token/display-time contract and adapter-reference generation key
as the smallest server-internal change; wire contracts and client normalization remain unchanged.

Verification passed:

- Focused coordinator, health, ingestion, and server suite: 195 tests.
- Broader provider, Claude, Codex, failover, authorization, ingestion, and server suite: 332 tests.
- `vp run typecheck`.
- `vp check` (zero errors; 11 pre-existing lint warnings in unrelated web files).
- `git diff --check`.

Focused tests now pin failure cleanup/retry, global concurrency, caller interruption, same-generation
joining, same-ID replacement, late-probe rejection, equal timestamps, backward display-clock values,
and token replay.

## Pass assessment

Two cy-review rounds are sufficient. Round two found and fixed the plausible regressions introduced by
round one's concurrency/lifecycle hardening, while the focused fleet independently found no remaining
map-cleanup wedge, semaphore-cap escape, Claude teardown leak, authorization regression, or unresolved
snapshot race under the new token contract. A third cy-review pass would be diminishing returns; the
planned separate write-capable reviewer is the appropriate final independent check.
