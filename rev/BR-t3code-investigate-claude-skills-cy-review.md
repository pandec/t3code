# Branch cy-review: Claude manual skill discovery

## Target

- Branch: `t3code/investigate-claude-skills`
- Base: `origin/dev`
- Diff: `git diff origin/dev...HEAD`
- Reviewed head: `0c226bdad07faeb5221b8c59099edaaf89a7d16e`
- Date: 2026-07-26
- Round: 1

Accepted product decisions excluded from review: skill selection continues to insert `$name`;
manual-only `$` references do not auto-invoke; lenient frontmatter recovery and empty-response
fallback are intentional; the baseline ProviderRegistry Hermes assertion is unrelated.

## Review fleet

| Reviewer                                   | Primary responsibility                                      | Reason selected                                                                   |
| ------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Skeptical code reviewer                    | Correctness, regressions, cleanup, parser edge cases, tests | The change adds async discovery and lenient metadata recovery.                    |
| Adversarial solution reviewer              | Challenge merge authority and solution boundaries           | The result joins three partially overlapping Claude discovery surfaces.           |
| Contract, performance, and test specialist | Wire compatibility, client parity, caching cost, isolation  | The optional field crosses RPC/snapshots and the picker exists on web and mobile. |

Three reviewers were used because the available concurrency ceiling allowed three subagents alongside
the accountable agent; their responsibilities cover the substantial server, contract, and cross-client
risk without duplicating a fourth generalist.

## Summary

- Raw reviewer findings: 12
- Additional executor-verified findings: 3
- Unique candidates after deduplication: 11
- Kept findings: 11
- Fix now: 9
- Deferred: 2
- Discarded: 0

## Combined findings

| ID    | File:line                                                         | Source roles                             | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                |
| ----- | ----------------------------------------------------------------- | ---------------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CY-1  | `apps/server/src/provider/Layers/ClaudeProvider.ts:690`           | skeptical, adversarial, specialist       | HIGH     | fix_now     | Discovery removes `user-invocable: false`, but the native SDK merge adds model-only skills back. Initialization commands are the user-invocation authority already returned by the same query.                                                                           |
| CY-2  | `apps/server/src/provider/Drivers/ClaudeSkills.ts:52`             | skeptical, specialist, accountable agent | MEDIUM   | fix_now     | Raw recovery mishandles inline comments and escaped quoted scalars, takes the first duplicate key, and misses valid indentation-before-chomping block headers such as `\|2-`.                                                                                            |
| CY-3  | `apps/server/src/provider/Drivers/ClaudeSkills.ts:160`            | skeptical, adversarial                   | MEDIUM   | fix_now     | Discovery keys names case-sensitively, so a case-only user/project collision survives until a sorted, case-folded merge can select the user entry instead of the project entry.                                                                                          |
| CY-4  | `apps/server/src/provider/Layers/ClaudeAdapter.test.ts:474`       | skeptical, specialist                    | LOW      | fix_now     | The interruption test still resolves the default Claude home and scans ambient user skills.                                                                                                                                                                              |
| CY-5  | `apps/mobile/src/features/threads/ThreadDetailScreen.tsx:245`     | specialist                               | MEDIUM   | fix_now     | Mobile still treats `[]` as authoritative in both existing-thread and new-task pickers, unlike the intentional web fallback.                                                                                                                                             |
| CY-6  | `apps/server/src/provider/Layers/ClaudeAdapter.ts:4083`           | adversarial                              | MEDIUM   | fix_now     | The filesystem scan runs before SDK initialization and consumes part of the adapter's 25-second cold-start budget; both independent operations can start together.                                                                                                       |
| CY-7  | `README.md:35`                                                    | accountable agent                        | LOW      | fix_now     | The fork feature description does not mention discovery of user-invocable manual-only Claude skills.                                                                                                                                                                     |
| CY-8  | `apps/server/src/provider/Layers/ClaudeAdapter.ts:4149`           | skeptical                                | MEDIUM   | defer       | A successful scan returned after native reload failure is known to omit plugin/bundle-only skills and therefore replaces a potentially broader snapshot with a partial list. Preserving both lists safely needs a partial-result signal or a principled cross-cwd merge. |
| CY-9  | `apps/server/src/provider/Drivers/ClaudeSkills.ts:200`            | accountable agent                        | MEDIUM   | defer       | Manual-only plugin skills can be absent from both `skills/reload` and the two filesystem roots scanned here. Initialization commands prove user invocation but do not identify which otherwise-unmatched slash commands are skills.                                      |
| CY-10 | `apps/server/src/provider/Drivers/ClaudeSkills.ts:218`            | accountable agent                        | MEDIUM   | fix_now     | Dropping a project `user-invocable: false` entry before collision handling allowed a same-name user skill to leak through, violating project precedence in snapshots and degraded scans.                                                                                 |
| CY-11 | `apps/mobile/src/features/threads/ComposerCommandPopover.tsx:145` | accountable agent                        | MEDIUM   | fix_now     | Mobile consumed manual-only skills but omitted the accepted `Manual` warning, leaving users unable to distinguish references that will not auto-invoke.                                                                                                                  |

## Deferred candidates

| ID   | Why deferred                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-8 | Fixing this without reintroducing stale project skills requires a response-completeness contract or a broader client merge policy. It is a real degraded-mode tradeoff, but not a safe local correction within this pass.                   |
| CY-9 | Surfacing unmatched initialization commands would also add ordinary built-in/plugin slash commands to the `$` skill picker. A follow-up needs authoritative SDK origin/kind metadata or plugin-aware discovery, not a name-shape heuristic. |

## Discarded summary

No unique candidates were discarded.

## Raw-output appendix

- All three reviewers independently identified the missing user-invocation authority in the merge.
- Two reviewers independently identified the case-only project-precedence failure.
- Contract review found the optional boolean backward-tolerant: old payloads omit it, while Effect
  schema decoding ignores unknown struct properties for older consumers.
- The 60-second shared query cache makes repeated file reads low-volume; the worthwhile performance
  fix is to avoid serializing the scan ahead of the already-expensive SDK initialization.

## Fixes applied

- Joined initialization commands, model-invocable SDK skills, and filesystem metadata without
  resurfacing model-only or effectively disabled skills.
- Hardened raw frontmatter recovery for comments, YAML quotes, duplicate keys, nested keys, and both
  block-scalar indicator orders.
- Made collision handling case-insensitive while preserving project precedence, including hidden
  project skills shadowing user skills.
- Ran scan and SDK initialization concurrently and isolated every adapter discovery test from the
  developer's Claude home.
- Shared the empty-response fallback between web and both mobile picker paths, and updated the README.
- Shared manual-only presentation logic and surfaced the accepted `Manual` warning in mobile.

## Verification

- Focused tests: 6 files, 103 tests passed.
- `vp check`: passed with 10 pre-existing non-blocking warnings.
- `vp run typecheck`: passed across all 15 tasks with pre-existing suggestions only.
- `vp run lint:mobile`: passed; optional SwiftLint, ktlint, and detekt are not installed.
- `git diff --check`: passed.
- Compatibility smoke: an old Effect `Schema.Struct` decoder discarded the new
  `modelInvocable` property, while the optional field accepts older payloads that omit it.
