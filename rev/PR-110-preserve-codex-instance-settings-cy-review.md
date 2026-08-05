# PR 110 Preserve Codex Instance Settings — cy-review

- Date: 2026-08-05
- Round: 1
- Branch: `worktree-codex-instance-fixes`
- Base: `origin/dev` at `53b09424e`
- PR: https://github.com/pandec/t3code/pull/110
- Diff: `origin/dev...268964510`

## Fleet

| Reviewer                          | Primary responsibility                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| Skeptical correctness             | Broad correctness, regressions, failure paths, contracts, and test strength                   |
| Adversarial solution              | Ownership boundaries, consistency, complexity, and hidden product assumptions                 |
| Codex launchArgs specialist       | End-to-end parity across start/resume, fork, native import, skills, and CLI import paths      |
| Import, CLI, and tests specialist | Provider-instance disambiguation, CLI output, web candidate identity, and regression coverage |

Four reviewers were used because this change crosses the Codex adapter, ephemeral app-server readers,
CLI presentation, and web import selection. The fleet was explicitly constrained to leave binary-path
tilde expansion out of scope and preserve stable instance IDs in ambiguous same-provider UI rows.

## Summary

- Raw findings: 1
- Kept after deduplication and source verification: 1
- Fix now: 1
- Deferred: 0
- Discarded: 0

## Combined findings

| Area                                     | Source roles         | Severity | Disposition | Rationale                                                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate provider display-name fallback | Adversarial solution | Low      | Fix now     | Session import candidates fell back directly to the raw driver slug when no custom instance name existed, unlike the provider catalog's snapshot-name fallback. This made the new CLI instance labels inconsistent with catalog and web presentation. |

## Fixes applied

- Session import candidate construction now follows the same display-name fallback as the provider
  catalog: custom instance name, provider snapshot name, then raw driver kind.
- Added a focused regression test for an unnamed provider instance whose snapshot supplies the
  user-facing provider name. Stable instance IDs remain unchanged in CLI and ambiguous UI labels.

## Verification

- `vp test run apps/server/src/sessionImport/SessionImportService.test.ts apps/server/src/provider/Drivers/CodexImportReader.test.ts apps/server/src/provider/Layers/CodexAdapter.test.ts apps/server/src/cli/session.test.ts apps/web/src/components/SessionImportDialog.logic.test.ts` — 5 files, 79 tests passed.
- Targeted `vp fmt --check` and `vp lint` for the fix and review artifact passed.
- `vp check` passed with 12 pre-existing warnings and no errors.
- `vp run typecheck` passed across all 15 packages; diagnostics were suggestions only.

## Deferred candidates

None.

## Review conclusions

The other three reviewers found no actionable issues. Launch arguments use the established resolver and
quote-aware app-server argv helper for forks and the shared list/read/skills import-reader path; instance
identity remains present in import payloads, candidate keys, CLI labels, and ambiguity errors. The focused
tests cover both configured and environment-overridden fork arguments, import-reader argv, same-driver
ambiguity, duplicate native session IDs across instances, and the intentional stable-ID UI rule.
