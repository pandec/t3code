# cy-review pass 2: message listening workflow

- Target: `t3code/message-listening-version`
- Base: `dev` at `cde22dd04164a964e3094def6a6665997ce0f395`
- Reviewed checkpoint: `c84381d52`
- Date: 2026-07-21
- Round: 2

## Review fleet

| Reviewer                                  | Primary responsibility                                   | Why selected                                                                                |
| ----------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Skeptical Code Reviewer                   | Re-test pass-1 fixes, concurrency, SQL, cleanup          | Pass 1 materially changed the backend's locking and persistence behavior.                   |
| Adversarial Solution Reviewer             | Challenge repaired boundaries and client audio ownership | The UI still has multiple row-local players and shares a process-wide mobile audio session. |
| Security, Data, and Cross-client Reviewer | Codex isolation, cache/storage races, asset failures     | Rewritten text crosses a provider boundary and generated files are served asynchronously.   |

Three reviewers were used because the environment supports three concurrent subagents alongside the coordinating agent. All were instructed to use `gpt-5.6-sol` at medium reasoning effort.

## Summary

- Raw findings: 7
- Deduplicated candidates: 6
- Kept: 6
- Fix now: 4
- Deferred: 2
- Discarded: 0

## Combined findings

| ID   | File:line                                                   | Sources         | Severity | Disposition | Rationale                                                                                                                                                  |
| ---- | ----------------------------------------------------------- | --------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1 | `apps/server/src/voice/MessageSpeech.ts:155`                | P2SK-1, P2SEC-2 | MEDIUM   | fix now     | The per-message semaphore map never evicts IDs, including failed or nonexistent requests.                                                                  |
| P2-2 | `apps/server/src/voice/MessageSpeech.ts:329`                | P2ADV-1         | MEDIUM   | fix now     | Interruption or partial failure after file creation can leave an MP3 without a cache row.                                                                  |
| P2-3 | `apps/server/src/textGeneration/CodexTextGeneration.ts:195` | P2SEC-1         | HIGH     | fix now     | Tool flags do not prevent Codex from automatically embedding repository `AGENTS.md`; speech generation must set `project_doc_max_bytes=0`.                 |
| P2-4 | `apps/web/src/components/chat/MessagesTimeline.tsx:1163`    | P2SEC-3         | MEDIUM   | fix now     | Asset URL failure is represented as perpetual loading on both clients, with no recovery affordance.                                                        |
| P2-5 | `apps/mobile/src/features/threads/ThreadFeed.tsx:1127`      | P2ADV-2         | MEDIUM   | defer       | Playback can change the process-wide Expo audio mode during voice recording. The product must choose whether playback is disabled or recording is stopped. |
| P2-6 | `apps/mobile/src/features/threads/ThreadFeed.tsx:1112`      | P2ADV-3         | MEDIUM   | defer       | Multiple visible row-local players can play simultaneously. This belongs with the already-deferred thread-level player ownership change.                   |

## Deferred candidates

P2-5 requires shared audio-session ownership between the composer and feed, plus a product choice about interruption. P2-6 should be solved together with pass-1 CR9 by lifting active playback above virtualized rows.

## Discarded summary

No material candidate was discarded in this pass.

## Verified fixes

- P2-1: keyed lock entries now use reference counts and are evicted after success, failure, or interruption; a concurrency test proves same-message serialization and eviction.
- P2-2: file creation and cache persistence are bracketed so any unsuccessful exit removes the new MP3.
- P2-3: Codex speech runs now set `project_doc_max_bytes=0` in addition to disabling tools and user configuration.
- P2-4: both clients distinguish asset loading from failure and provide a dismiss-and-retry path.

Pass-2 verification: 215 focused tests passed; `vp check`, the full 15-package typecheck, and mobile native lint passed. The 10 lint warnings are pre-existing and outside this diff.
