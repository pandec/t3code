Run $cy-review on the diff of this branch versus origin/dev (`git diff origin/dev...HEAD`), which is two commits fixing Claude Code skill discovery for T3's composer `$` picker.

## What the change does

T3's Claude `$` skill picker sourced its list solely from the Agent SDK's `skills/reload` control request, which reports ONLY skills the model may invoke. Skills whose SKILL.md frontmatter sets `disable-model-invocation: true` are absent from it, even though they remain runnable by hand as `/name` slash commands. Result: `$dotfiles-sync` found nothing while `/dotfiles-sync` resolved fine. Verified empirically against Claude Code CLI 2.1.220: 99 slash commands vs 62 reloaded skills, and the 4-5 missing user skills were exactly the ones with `disable-model-invocation: true`.

The fix merges the SDK list with a filesystem scan of the same workspace (`mergeClaudeSkills` in apps/server/src/provider/Layers/ClaudeProvider.ts), adds `modelInvocable` to the `ServerProviderSkill` contract, makes frontmatter parsing tolerant of YAML that Claude Code itself accepts, drops `user-invocable: false` skills, and stops treating an empty skills response as authoritative on the client.

## Accepted decisions — do NOT re-litigate

- Selecting a skill still inserts a `$name` token uniformly. We deliberately did NOT rewrite manual-only skills to `/name`: slash commands only work at the start of an empty message, and the user explicitly wants to reference skills mid-message.
- Consequently, a `Manual`-flagged skill referenced via `$` will not auto-invoke. That is a known, accepted limitation of this change, surfaced via the "Manual" label in the picker. Do not implement prompt-expansion or token routing.
- Lenient frontmatter recovery is intentional: Claude Code loads skills that the strict `yaml` parser rejects, and dropping them silently hid real skills.
- `resolveEffectiveProviderSkills` treating `[]` as "no answer" is intentional.
- `apps/server/src/provider/Layers/ProviderRegistry.test.ts` > "keeps cursor disabled and skips probing when the provider setting is disabled" already FAILS on clean origin/dev (a stale assertion that omits the `hermes` provider). It is unrelated to this diff — do not fix it and do not count it as a regression.

## Please scrutinise particularly

1. `readRawFrontmatterField` in apps/server/src/provider/Drivers/ClaudeSkills.ts — the line-scan fallback. Correctness of quote stripping, the block-scalar guard, behaviour when the same key appears twice, keys nested under a parent mapping being matched at top level, and whether the dynamically built RegExp is safe for the field names actually passed.
2. `mergeClaudeSkills` — is `modelInvocable: false` for every scan-only skill sound? It assumes the SDK list is complete for the same cwd. Consider plugin skills, name-casing collisions, and the project-vs-user scope precedence interaction.
3. `ClaudeAdapter.listSkills` — the new failure policy: SDK failure plus a non-empty scan returns the scan and logs; SDK failure plus an empty scan propagates the error. Check that the discovery query is still always closed, that interruption still aborts, and that the scan cannot itself throw or block.
4. Whether the filesystem scan on every picker keystroke-triggered lookup introduces a meaningful cost (it reads every SKILL.md), given the 60s client-side stale time.
5. Test isolation: the adapter tests now pass an explicit `homePath` so discovery does not read the developer's real `~/.claude`. Confirm no remaining test reads real user state.
6. Contract compatibility: `modelInvocable` is an optional boolean added to `ServerProviderSkill`, which travels over the WS RPC and appears in provider snapshots. Check older/newer peer tolerance.

Commit your fixes locally on the current branch, but do NOT push and do NOT open a PR — the user will handle that.

Let me know if you think one more review is warranted or if it would be diminishing returns.
