# PR 78 cy-review: live multi-account provider usage meter

- Branch: `provider-usage-live`
- Base: `origin/dev` at `23b32ac3d02ae9ef1157dc7ab25b8135703dba00`
- Reviewed head: `5c2b3affe6014c11e9a64bbc5411e34e7f67a743`
- PR: https://github.com/pandec/t3code/pull/78
- Date: 2026-07-30
- Round: 1
- Diff: `origin/dev...HEAD`

## Fleet

Three reviewers were used because the four-slot execution limit allows three parallel subagents plus
the accountable primary reviewer.

- Skeptical async reviewer: Claude probe lifecycle, refresh isolation/cap, snapshot races, health
  verdicts, and failover semantics.
- Adversarial auth reviewer: RPC scopes, process-spawn authorization, server ownership, and
  multi-client abuse resistance.
- Client/mobile/test reviewer: live-instance resolution, refresh interactions, age rendering,
  redaction, mobile parity, and focused coverage.

All reviewers ran with GPT-5.6 Sol at medium reasoning effort. The adversarial reviewer used the
dedicated adversarial role.

The repo-required API design check was also run read-only through Claude Fable at medium effort. It
confirmed that a server-singleton refresh coordinator and source-observation timestamps are the
smallest coherent boundaries for the two cross-client/race fixes.

## Summary

- Raw findings: 9
- Deduplicated kept findings: 7
- Fix now: 6
- Deferred: 1
- Discarded: 1

## Combined findings

| ID   | File:line                                                           | Sources     | Severity | Disposition | Rationale                                                                                                                                                            |
| ---- | ------------------------------------------------------------------- | ----------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-1 | `apps/server/src/provider/Layers/ClaudeAdapter.ts:4503`             | ASYNC       | HIGH     | fix now     | Timeout/interruption only aborted the SDK controller; `close()` waited for the underlying promise to settle, so the CLI child could outlive the 15-second RPC bound. |
| CY-2 | `apps/server/src/provider/Layers/ClaudeAdapter.ts:4562`             | ASYNC       | MEDIUM   | fix now     | The adapter converted caller interruption into `undefined`, preventing the refresh coordinator from stopping cancelled work correctly.                               |
| CY-3 | `apps/server/src/provider/refreshProviderUsage.ts:42`               | ASYNC, AUTH | MEDIUM   | fix now     | The concurrency cap and client single-flight were per call/client, allowing correctly scoped concurrent clients to spawn duplicate probes beyond the intended cap.   |
| CY-4 | `apps/server/src/provider/Layers/ProviderInstanceHealthLive.ts:171` | ASYNC       | MEDIUM   | fix now     | Arrival-time stamping let an older refresh started during a turn overwrite a newer turn-boundary snapshot after completing later.                                    |
| CY-5 | `apps/server/src/ws.ts:1024`                                        | AUTH        | MEDIUM   | fix now     | Disabled or removed instances retained indefinitely readable raw snapshots even though refresh correctly skipped them.                                               |
| CY-6 | `apps/mobile/src/lib/providerUsageMenu.ts:35`                       | CLIENT      | MEDIUM   | fix now     | Mobile concatenated multiple window values without their Session/Weekly labels, making the percentages ambiguous.                                                    |
| CY-7 | `apps/mobile/src/lib/providerUsageMenu.ts:74`                       | CLIENT      | LOW      | defer       | Mobile exposes the full account email while web uses an explicit reveal control; the native-menu disclosure behavior needs a product choice.                         |

## Validated non-findings

- The Claude ephemeral prompt is an async generator that never yields, so it sends no user turn and
  consumes no inference. It does not enter the adapter's durable session map.
- The probe uses a separate non-persistent SDK query with tools, settings, and MCP servers disabled;
  no direct cross-talk with a real same-instance session was found.
- Disabled and unsupported instances, absent usage readers, undefined payloads, and per-instance
  failures are handled correctly by the refresh eligibility/error paths.
- Usage snapshots remain separate from rate-limit verdict state. Percentage payloads classify as
  unknown, so the new meter state does not clear or create failover routing verdicts.
- RPC authorization is correctly split: read requires orchestration-read and refresh requires
  orchestration-operate. Authentication and scope wrapping happen before the lazy refresh effect can
  spawn a process.
- The live session instance wins over the persisted model selection, with the selection as fallback,
  on both web and mobile.
- The five-second callback guard and client single-flight prevent popover-open/manual-button
  double-fires in one client. The suggestion to refresh when any row is stale was rejected because
  the accepted contract explicitly uses the newest snapshot's age.
- Web renders per-row freshness/staleness and uses `RedactedSensitiveText`; no changed path logs
  provider emails or raw usage payloads.
- Server snapshots and activity fallback use the same client normalizer; no second payload parser
  was introduced.
- A sparse passive Claude event may temporarily replace the full server snapshot during a running
  turn, but the accepted contract promises the structured free snapshot after the turn. The
  turn-boundary refresh is coalesced and becomes authoritative without adding server-side parsing.

## Deferred candidates

| ID   | Scope                              | Reason                                                                                                                                                                                        |
| ---- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-7 | Mobile account identity disclosure | Native menus have no equivalent of web's click-to-reveal redaction control. Masking, omitting, or adding a reveal flow is a user-visible product choice rather than a correctness-only patch. |

## Resolution

All six fix-now findings were resolved:

- Claude usage probes now close immediately on timeout or interruption while retaining the no-user-turn
  prompt, and external interruption is no longer swallowed.
- Refresh is coordinated by one server-scoped service with a global concurrency limit of three,
  per-instance single-flight, caller-independent probe lifetime, per-instance failure isolation, and
  enabled/usage-capable eligibility filtering.
- Snapshot writes carry the provider observation's start timestamp and reject older arrivals, preventing
  a slow refresh from overwriting a newer turn-boundary snapshot.
- Usage reads filter out disabled and removed instances without mutating the retained health state.
- Mobile rows include their usage-window labels.
- RPC tests pin the read/operate scope split and prove a read-scoped caller cannot trigger refresh work.

Verification passed:

- Focused provider, ingestion, client-runtime, mobile, server, authorization, Codex, and failover suites.
- `vp run typecheck`.
- `vp check` (zero errors; 11 pre-existing lint warnings in unrelated files).
- `git diff --check`.

Integrated browser/mobile verification was not run: the fixes are covered at the service, RPC, adapter, and
rendering-helper boundaries, and no runtime-only client integration path was changed.
