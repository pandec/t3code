# cy-review pass 1: message listening workflow

- Target: `t3code/message-listening-version`
- Base: `dev` at `cde22dd04164a964e3094def6a6665997ce0f395`
- Diff: complete local working-tree diff against `HEAD`
- Date: 2026-07-21
- Round: 1

## Review fleet

| Reviewer                                  | Primary responsibility                                                               | Why selected                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Skeptical Code Reviewer                   | Correctness, regressions, async races, cleanup, tests                                | The feature crosses provider processes, HTTP, SQLite, files, and two virtualized clients. |
| Adversarial Solution Reviewer             | Boundaries, ownership, cache design, product assumptions                             | The feature introduces a new derived artifact and multi-provider generation operation.    |
| Security, Data, and Cross-client Reviewer | Prompt/tool isolation, external API limits, persistence, signed assets, UI lifecycle | Rewritten content leaves the machine through ElevenLabs and playback spans web/mobile.    |

Three reviewers were used because the environment supports three concurrent subagents alongside the coordinating agent. All were instructed to use `gpt-5.6-sol` at medium reasoning effort.

## Summary

- Raw findings: 13
- Deduplicated candidates: 10
- Kept: 9
- Fix now: 8
- Deferred: 1
- Discarded: 1

## Combined findings

| ID   | File:line                                                        | Sources     | Severity | Disposition | Rationale                                                                                                                                                                                                                                                  |
| ---- | ---------------------------------------------------------------- | ----------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR1  | `apps/server/src/textGeneration/CodexTextGeneration.ts:189`      | SK-1, SEC-1 | HIGH     | fix now     | Codex speech rewriting retains repository-reading tools, so injected source text could cause additional workspace data to enter the transcript sent to ElevenLabs.                                                                                         |
| CR2  | `apps/server/src/voice/MessageSpeech.ts:211`                     | ADV-1       | MEDIUM   | fix now     | Cache identity omits the selected rewrite provider/model/options and prompt recipe version.                                                                                                                                                                |
| CR3  | `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:420` | ADV-2, SK-3 | MEDIUM   | fix now     | Revert pruning skips all MP3s and leaves rows/files for removed messages.                                                                                                                                                                                  |
| CR4  | `apps/server/src/voice/MessageSpeech.ts:271`                     | SK-4, SEC-2 | MEDIUM   | fix now     | A long-running synthesis can write a new row/file after its message or thread was deleted or reverted.                                                                                                                                                     |
| CR5  | `packages/client-runtime/src/state/voice.ts:21`                  | SK-2        | MEDIUM   | fix now     | The 240-second client timeout is shorter than the valid 180-second rewrite plus 120-second TTS budget, before queueing.                                                                                                                                    |
| CR6  | `apps/mobile/src/features/threads/ThreadFeed.tsx:1563`           | SK-5        | MEDIUM   | fix now     | `textToSpeechAvailable` is captured by `renderItem` but omitted from LegendList `extraData`.                                                                                                                                                               |
| CR7  | `packages/contracts/src/voice.ts:36`                             | SEC-3       | MEDIUM   | fix now     | The configurable ElevenLabs model has a fixed 40,000-character acceptance limit even though official limits vary by model.                                                                                                                                 |
| CR8  | `apps/web/src/components/ChatView.tsx:5387`                      | SEC-4       | MEDIUM   | fix now     | Feed remount keys use unscoped thread IDs, allowing state to survive a same-ID environment switch.                                                                                                                                                         |
| CR9  | `apps/web/src/components/chat/MessagesTimeline.tsx:1037`         | ADV-4       | MEDIUM   | defer       | Player/result state owned by virtualized rows can disappear and stop playback when a long message scrolls off-screen. Moving playback ownership above both virtualized clients is a material cross-client interaction change best handled separately.      |
| CR10 | `apps/server/src/textGeneration/TextGenerationPrompts.ts:228`    | ADV-3       | MEDIUM   | discard     | The user explicitly chose an AI rewrite that may slightly restructure visual content while preserving information. Replacing it with deterministic normalization would contradict that product decision; the collapsed transcript provides inspectability. |

## Deferred candidates

CR9 remains valid. A shared thread-level player should preserve playback when its source row is recycled and decide whether the UI becomes a persistent mini-player, an inline portal, or both.

## Discarded summary

One proposed architecture change conflicted with the user's explicit request for a model-assisted, listening-friendly rewrite. No style-only or speculative findings were retained.

## Verified fixes

- CR1: Codex speech generation now ignores user/rule configuration and disables shell, unified execution, browser, apps, and multi-agent tools.
- CR2: the cache key now includes a versioned fingerprint of the selected text-generation model and options.
- CR3: revert pruning removes speech rows and MP3s for messages no longer retained.
- CR4: persistence uses a conditional insert that revalidates the exact completed assistant message after generation and removes the file if the message disappeared.
- CR5: synthesis uses per-message locks instead of a global queue, with a 330-second client budget for the 180-second rewrite plus 120-second TTS limits.
- CR6: mobile LegendList `extraData` now includes TTS availability.
- CR7: known ElevenLabs models use their documented per-request character limits, with a conservative limit for unknown overrides.
- CR8: web and mobile feed remount keys now include the environment identity.

Pass-1 verification: 214 focused tests passed; `vp check`, the full 15-package typecheck, and mobile native lint passed. The 10 lint warnings are pre-existing and outside this diff.
