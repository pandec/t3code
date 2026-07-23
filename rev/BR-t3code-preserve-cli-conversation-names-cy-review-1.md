# cy-review pass 1

- Target: `t3code/preserve-cli-conversation-names`
- Base: `origin/dev` at `633ad2f30`
- Diff base: `HEAD` (uncommitted branch diff)
- Date: 2026-07-23
- Round: 1

## Fleet

Four reviewers were used because the small diff changes a shared provider contract across Codex and
Claude:

- Skeptical correctness reviewer: regressions, edge cases, and test strength.
- Adversarial solution reviewer: title-policy ownership and exact-preservation semantics.
- Provider-contract specialist: provider-native metadata and continuation compatibility.
- Test/reuse reviewer: boundary coverage and existing reusable policy.

## Summary

- Raw findings: 6
- Kept after deduplication and verification: 3
- Fix now: 2
- Deferred: 1
- Discarded: 1

## Combined findings

| Finding                                                                                      | Sources           | Location                                                         | Severity | Disposition | Rationale                                                                                                                                             |
| -------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider names are incorrectly subjected to the generated-title 80-character cap             | ADV-1, SK-1, TR-3 | `apps/server/src/sessionImport/SessionImportService.ts:70`       | Medium   | Fix now     | Long names are not preserved and UTF-16 truncation can split an emoji. Keep the existing cap only for generated fallback titles.                      |
| The combined truncation/newline test does not independently prove provider-name preservation | TR-2              | `apps/server/src/sessionImport/SessionImportService.test.ts:258` | Low      | Fix now     | Replace it with an exact-preservation assertion covering a long, Unicode, multiline provider value.                                                   |
| Claude's project-directory encoding can collide for distinct canonical paths                 | PC-1              | `apps/server/src/provider/Drivers/ClaudeSessionImport.ts:285`    | Medium   | Defer       | This is a valid pre-existing provenance issue, but correcting it requires a transcript-cwd compatibility policy beyond this title-preservation patch. |

## Deferred candidate

| Finding                                                                 | Why deferred                                                                                                                                                         |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validate Claude transcript cwd against the selected canonical workspace | The transcript format and compatibility behavior for older/moved sessions need focused design and tests; changing it here would broaden a narrow import-title patch. |

## Discarded summary

- TR-1 requested full adapter integration tests for two typed one-line mappings. Claude's parser already
  proves custom-title extraction, Codex's generated `thread/read` type includes `name`, and the required
  shared history field makes omissions fail typecheck. Additional adapter harnesses would add more setup
  than regression value for this change.
