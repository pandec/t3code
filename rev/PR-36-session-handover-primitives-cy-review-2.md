# PR #36 cy-review — session handover primitives (round 2)

- Branch: `feat/session-cli`
- Base: `origin/dev`
- PR: https://github.com/pandec/t3code/pull/36
- Date: 2026-07-25
- Diff base: `4835c210a275fd563e87fea4c08fff3185b79a55`
- Reviewed head: `919ce56e24ad2cb66afcdbd1fc4790a53c316f26`
- Round: 2

## Review fleet

| Reviewer                  | Primary responsibility                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Skeptical regression lane | Transcript sniffing, canonical CWD, provider-home consistency, and round-one fix verification        |
| Path/process lane         | macOS/Linux provider homes, continuation namespaces, worktrees, and bounded child-process execution  |
| HTTP/contract lane        | Read/operate scopes, typed error decoding, transport deadlines, and older-server capability gates    |
| Adversarial lane          | Cross-module resumability, retry semantics, mutation ordering, and challenges to the chosen solution |

Four fresh reviewers were used because the second pass needed independent scrutiny of the round-one fixes across provider persistence, filesystem placement, Git, and authenticated HTTP.

## Summary

- Raw findings: 9
- Kept after verification and deduplication: 6
- Fix now: 6
- Deferred: 0
- Discarded/deduplicated: 3

## Combined findings

| ID    | File:line                                                                                                             | Sources      | Severity | Disposition | Rationale                                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ------------ | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR2-1 | `apps/server/src/provider/Drivers/ClaudeHome.ts:18`; `apps/server/src/provider/Drivers/CodexHomeLayout.ts:44`         | R2S-1, R2P-1 | HIGH     | fix now     | Default-instance placement identities ignore inherited/per-instance `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `HOME`, so the CLI can place a transcript outside the home used by the provider subprocess.      |
| CR2-2 | `apps/server/src/cli/session.ts:205`                                                                                  | R2S-2, R2A-4 | MEDIUM   | fix now     | Codex sniffing accepts a non-UUID id and a rollout filename that does not claim that id, contrary to the defensive contract and actual UUIDv7 rollout naming.                                               |
| CR2-3 | `apps/server/src/sessionImport/SessionImportService.ts:155`                                                           | R2P-2        | HIGH     | fix now     | Duplicate ownership is indexed by provider instance rather than continuation namespace, allowing two same-home instances to attach separate T3 threads to the same native transcript.                       |
| CR2-4 | `apps/server/src/sessionImport/SessionImportService.ts:185`                                                           | R2P-3        | MEDIUM   | fix now     | Server-side worktree validation runs Git without a deadline or output cap, so an authenticated request can wait indefinitely or consume unbounded memory.                                                   |
| CR2-5 | `apps/server/src/sessionImport/SessionImportService.ts:585`; `apps/server/src/provider/Layers/ProviderService.ts:692` | R2A-1        | HIGH     | fix now     | A warning-only metadata failure leaves the imported worktree CWD authoritative only for the first start; later starts can fall back to the project root, violating the accepted non-fatal-warning contract. |
| CR2-6 | `apps/server/src/cli/session.ts:972`                                                                                  | R2A-3        | MEDIUM   | fix now     | Provider/model/effort validation happens after project/worktree/provider-file mutations, so known-invalid options can leave persistent residue without an import attempt.                                   |

## Deferred candidates

No items deferred from triage. Relative provider-home environment values will retain their runtime-relative identity without being advertised as a static placement home; no HTTP contract change is required.

## Discarded summary

- Two Codex identity reports and two provider-home reports were duplicate descriptions consolidated above.
- The proposed destination-equivalence check for `already-imported` was discarded because the settled retry contract intentionally uses deterministic native ownership plus `existingThreadId`; adding client-side destination machinery would reopen that accepted trade-off.
- The HTTP lane found no scope, decoding, timeout, route-registration, or older-server capability-gating defect.
- No shell-quoting injection, repository/branch validation bypass, symlink canonicalization flaw, or atomic hard-link placement defect was substantiated.

## Raw-output audit notes

- Skeptical lane: two kept findings; no additional canonical-CWD or capability-gating issue.
- Path/process lane: three findings, one corroborating the provider-home mismatch; Git argument-vector construction and placement paths otherwise held.
- HTTP/contract lane: no material findings; its focused 16-test run and `git diff --check` passed.
- Adversarial lane: four candidates; three were kept or deduplicated, while the destination-equivalence proposal was rejected under the explicitly accepted retry semantics.

## Fix-pass result

All six verified findings were fixed without changing the locked HTTP request or response shapes. Follow-up review of the fix diff by the skeptical, path/process, and adversarial lanes found no remaining material defect.

- Focused verification: 8 files, 97 tests passed.
- `vp check`: passed with the 11 pre-existing unrelated web warnings.
- `vp run typecheck`: passed with pre-existing Effect suggestions only.
- Deferred items: none.
