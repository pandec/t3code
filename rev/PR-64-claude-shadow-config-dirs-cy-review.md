# PR 64 cy-review — Claude shadow config dirs

- Branch: `claude-shadow-home`
- Base: `origin/dev` at `32360f41dd9e3f2c4399db0ff7603ce807ac5cbe`
- Reviewed head: `b5086c48bb3e1e29229274b28975a1e3c25d9697`
- Diff: `origin/dev...HEAD`
- PR: https://github.com/pandec/t3code/pull/64
- Round: 1
- Started: `2026-07-29T07:33:00Z`

## Fleet

Three parallel Sol-medium reviewers were used, which is the maximum available alongside the accountable executor:

- Filesystem/state specialist — symlink states, path topology, conflicts, mutation ordering, idempotency, and partial/manual layouts.
- Provider integration/contracts specialist — driver failure isolation, widened call contracts, settings schemas, and cache-key consumers.
- Adversarial solution/test reviewer — failure-path challenge and test false-pass analysis within the four accepted design constraints.

The executor independently audited the complete diff, callers, registry creation path, settings patch path, and cache-key consumers.

## Summary

- Raw findings: 9
- Deduplicated findings kept for validation: 8
- Proposed fix now: 7
- Proposed deferred: 1
- Discarded at compilation: 0

## Combined findings

| ID  | File:line                                | Sources    | Severity | Proposed disposition | Rationale                                                                                                                                                                    |
| --- | ---------------------------------------- | ---------- | -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `ClaudeHomeLayout.ts:262`                | FS-1       | HIGH     | fix now              | Lexical equality misses canonical aliases and overlapping/nested layouts, which can mutate shared private state or create recursive links.                                   |
| C2  | `ClaudeHomeLayout.ts:297`                | FS-2       | MEDIUM   | fix now              | A previously managed optional link is left dangling when its shared target disappears.                                                                                       |
| C3  | `ClaudeHomeLayout.ts:317`                | FS-3, AT-1 | HIGH     | fix now              | Known shared-entry conflicts are discovered only after private links and earlier overlay entries may have been mutated.                                                      |
| C4  | `ClaudeHomeLayout.ts:164`                | FS-4       | MEDIUM   | fix now              | Concurrent materialization can report converged `AlreadyExists`/`NotFound` races as driver failures.                                                                         |
| C5  | `ClaudeHomeLayout.ts:297`                | AT-2       | MEDIUM   | defer                | An initially absent optional entry can be created shadow-local and later conflict with a newly introduced shared entry; the desired ownership rule needs a product decision. |
| C6  | `ClaudeDriver.ts:134`                    | AT-3       | MEDIUM   | fix now              | Tests do not exercise the driver/registry materialization boundary or prove one failed Claude instance is isolated.                                                          |
| C7  | `ClaudeHomeLayout.ts:106`                | AT-4       | MEDIUM   | fix now              | Relative inherited `CLAUDE_CONFIG_DIR` is resolved against process cwd instead of the established server workspace cwd.                                                      |
| C8  | `packages/contracts/src/settings.ts:627` | PC-1       | MEDIUM   | fix now              | `ClaudeSettingsPatch` omits `shadowHomePath`, so typed legacy settings updates strip the new field.                                                                          |

## Deferred candidate

| ID  | Scope                           | Why not fix in this pass                                                                                                                                                                                                  |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C5  | Optional shared-entry lifecycle | The implementation explicitly avoids fabricating optional entries. Preventing later shadow-local creation would require choosing new directory/file ownership semantics rather than correcting an implementation mistake. |

## Discarded summary

No finding was discarded before code-level validation. The accepted parallel-module, continuation-group, environment precedence, and whitelist decisions were not re-litigated.

## Validated disposition

- Fixed C1 by rejecting lexical overlap before mutation and canonical overlap after directory resolution.
- Fixed C2 by removing only stale optional symlinks that still target the expected missing shared entry.
- Fixed C3 by preflighting every required and present optional entry before existing shadow state is changed.
- Fixed C4 by treating converged `NotFound` removals and matching `AlreadyExists` creations as success.
- Deferred C5 because it requires an ownership decision for optional entries that do not yet exist.
- Fixed C6 with a registry-level test covering both successful materialization and per-instance failure isolation.
- Fixed C7 by resolving inherited relative config dirs against `ServerConfig.cwd`.
- Fixed C8 by adding `shadowHomePath` to `ClaudeSettingsPatch` and covering trim/preservation through the settings service.
