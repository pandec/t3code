# Cross-machine session handover

Status: **agent-driven v0 CLI primitives implemented; agent skill and integrated cross-machine verification remain**. The in-app "Hand off to →" UI is deferred to v2. Feasibility empirically verified 2026-07-24; design reviewed against the codebase by an independent agent pass on 2026-07-24 (findings folded in below).

## Motivation

Same repos live at the same home-relative paths on multiple machines (space-mac, grey-mac, ubuntu-dell). When closing one laptop mid-task, an in-progress Claude/Codex thread should be movable to another machine and continued **natively, with full history** — not via a lossy summary.

## Key insight

T3 stores no transcripts for native sessions — only a resume cursor in `provider_session_runtime` (Claude session UUID / Codex thread id; see `apps/server/src/persistence/ProviderSessionRuntime.ts`, cursors built in `ClaudeAdapter.ts` ~3680 and `CodexSessionRuntime.ts:67-72`). The actual conversation lives in the provider's own home:

- Claude: `~/.claude/projects/<escaped-cwd>/<uuid>.jsonl` (escaped-cwd = absolute cwd with non-alphanumerics replaced by `-`, derived in `apps/server/src/provider/Drivers/ClaudeSessionImport.ts:285-313`)
- Codex: rollout JSONL under `~/.codex/sessions/YYYY/MM/DD/` + Codex's own state DB index

Therefore **handover = transfer the provider file(s) + run the existing session-import** (`apps/server/src/sessionImport/SessionImportService.ts`, RPC `sessionImport.listCandidates` / `sessionImport.import`) on the target. T3 database rows are never moved — they are environment-scoped (environment id, auth tables, `revision`, `provider_instance_id`) and threads are intentionally environment-local (`docs/architecture/remote.md:180-189`).

## Verified by experiment (2026-07-24, space-mac → ubuntu-dell)

Two rounds, both successful on first attempt with **unmodified files**:

1. **Trivial sessions**: Claude JSONL copied into the target's translated escaped-cwd dir (`-Users-bartoszdec-…` → `-home-bartoszdec-…`); `claude -p --resume <uuid>` recalled session content, same UUID retained. Codex rollout copied into the same relative `~/.codex/sessions/` date dir; `codex exec resume <thread-id>` worked — Codex's filename-scan fallback finds the rollout **without** a state-DB entry, even across version skew (0.145.0 → 0.144.6).
2. **Realistic sessions with tool calls**: multi-turn Claude session with Write/Edit/Bash history (50 embedded `/Users/…` occurrences in tool inputs/results/cwd fields) plus a dirty git tree (uncommitted edit + untracked file), and a Codex session with file writes. Repo rsynced, transcripts copied unmodified. Both resumed on Ubuntu and **continued editing the same files correctly**. `tool_use`/`tool_result` records are inert history — nothing re-executes on resume. Claude self-noticed the cwd change (`pwd` differs from history) and adapted; **no JSONL path rewriting is needed**. Only the Claude _directory name_ must be translated for the target's absolute path.

Caveats found (experiment + code review):

- Session-scoped side state (todos, rewind/file-history checkpoints, shell snapshots, background shells) does not travel. Continuation is unaffected; rewind cannot reach back before the handover.
- Handover must be **one-shot/directional**: two machines resuming the same session id fork the transcript. (Enforced at the T3 layer only — nothing stops `claude --resume` in a terminal on the source; acceptable.)
- **Never blind-copy the Claude project dir**: the target usually already has `~/.claude/projects/<escaped-cwd>/` for the same repo with its own `memory/`. Copy the session `.jsonl` always; other files (e.g. `memory/`) copy-missing-only, never overwrite.
- Import pipeline caps: `THREAD_IMPORT_MAX_MESSAGES` = 5,000 messages, `MAX_SESSION_FILE_BYTES` = 256 MB. Beyond the cap, import fails even though native resume works.
- The Claude transcript parser is deliberately strict (`ClaudeSessionImport.ts:228-232`): one unknown record type fails the parse. Claude Code version skew between machines can therefore break _import_ while native resume still works. Codex skew verified tolerant; Claude parser skew untested.

## v0: agent-driven handover (CLI + skill) — the implementation target

Insight from practice: an agent with SSH access to all machines can already perform the full handover today. The transcript transfer is proven; remote thread creation via the `t3` CLI is proven (the CLI is on all 3 machines via the dotfiles shim, `~/.local/bin/t3`, running the installed app's bundled `bin.mjs` through `ELECTRON_RUN_AS_NODE`). The only missing primitive is a CLI path into session import. The user interface for v0 is conversational: tell any thread "move this session to <machine>", and the agent executes the recipe.

### Division of labor

**The CLI moves conversations; the agent reproduces repository state.**

### CLI additions (fork, PR to dev)

1. **`t3 session import --file <transcript> --project <id-or-path> [--worktree-branch B] [--model M] [--effort E] [--instance I] [--json]`**
   - Sniffs provider, native session id, source cwd, and last-used model from the file itself (Codex rollouts start with `session_meta`; Claude JSONLs are typed message lines). No provider/id flags needed.
   - **Does the placement itself**: computes the target escaped-cwd dir for the effective project path and installs the Claude file there, or drops the Codex rollout into `~/.codex/sessions/<date>/`. Path translation is the most error-prone step — code owns it. Never overwrites an existing file.
   - `--worktree-branch` derives and creates the standard T3 worktree path; free-form worktree paths are not accepted. It fails clearly if the branch is absent locally — the CLI never fetches. Unlike the UI bootstrap flow, this CLI path does not run the project setup script or trigger a git-status refresh.
   - Defaults model selection from the transcript, overridable.
   - Validates defensively: session id UUID pattern, id-inside-transcript matches filename claim, size caps, provider instance/model options, and server-side worktree identity.
   - Uses authenticated HTTP session-import endpoints while retaining the existing binding-first transaction and deterministic duplicate recovery.
   - `--title` is intentionally absent; imported provider names remain authoritative, and later renames use `t3 thread rename`.
2. **`t3 session candidates --project <id-or-path> [--cwd <worktree>] [--json]`** — standalone candidate inspection for a project or validated existing worktree.
3. **`t3 thread new ... --model M [--effort E] [--instance I]`** — explicitly selects an advertised provider model; with no model flags, project-default behavior is unchanged.
4. **`t3 thread archive <thread-id>`** — required so the agent can mark the source thread handed-off (archive exists in the UI multi-select only).
5. **Bugfix**: `t3 project list --json` times out against a live server (reproduced on grey-mac while `status`/`thread` commands work). The recipe resolves projects by path, so this must work.

### Agent skill (`t3-session-handover`, references remote-machines + t3-cli)

Recipe the skill encodes:

1. Quiescence: check thread state; if a turn is running, interrupt only with user consent.
2. Git state: verify committed + pushed; dirty tree → ignore-aware patch of tracked + untracked-not-ignored files (size-capped), applied on the target only if clean and holding the base commit; otherwise stop with an actionable message. No auto-stash, no WIP refs.
3. Ensure the branch's commit is on the target (`git fetch` over SSH).
4. Locate provider files on the source (resume cursor → session id → transcript path), `scp` to the target.
5. Run `t3 session import` on the target (via SSH, `~/.local/bin/t3`).
6. **Only after import success**: archive the source thread (`t3 thread archive`) with a handed-off title note. Failed import needs no rollback — the placed transcript degrades to a regular import candidate on the target, and retry is idempotent.
7. If import fails on caps or parser strictness: report clearly; the session still resumes natively (`claude --resume` / `codex exec resume`) and can be imported after a T3 update. Do not paper over parse failures.

### The two worktree cases

- **Case A — T3-managed worktree thread** (worktree selected at thread creation): the thread's cwd _is_ the worktree; the transcript is keyed to it. The CLI's `--worktree-branch` recreates it and places the session under its path.
- **Case B — thread in the main repo dir, agent working in a self-made worktree**: T3 and the provider key everything to the main repo dir; the worktree is just state the conversation _talks about_. CLI import is plain (project = main repo dir). The agent recreates the auxiliary worktree with ordinary git (`git worktree add <same relative path> <branch>`) so the resumed agent's references resolve. The CLI must not try to parse conversation content to guess such worktrees.

### Decisions locked for v0

| #   | Decision                  | Choice                                                                                                                                                                              |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Dirty tree                | Patch + clean-target + has-commit, else fail actionably; ignore-aware; size-capped                                                                                                  |
| 2   | Source thread fate        | Archive only after target import success; one-shot; honest that CLI resume on source remains physically possible                                                                    |
| 3   | Direction                 | Agent-driven flow is inherently direction-agnostic (SSH both ways). Note: pull does **not** rescue a closed-laptop source — both ends must be reachable at handover time regardless |
| 4   | Mid-turn                  | Require quiescence; interrupt only with user consent; queued messages (fork feature) are T3-side state and do not travel — surface them before interrupting                         |
| 5   | Memory/side files         | Session file always; everything else copy-missing-only; never overwrite target files                                                                                                |
| 6   | Caps/parser skew          | Fail clearly, leave files placed (native resume + later import both remain available); revisit raising `THREAD_IMPORT_MAX_MESSAGES` if hit in practice                              |
| 7   | Provider scope            | Claude + Codex only (verified). Cursor/Grok/OpenCode untested                                                                                                                       |
| 8   | Missing project on target | Repo exists at translated path → auto-add project; repo missing → fail, no cloning                                                                                                  |
| 9   | Handover note             | Inject "this session was handed over; repo now lives at `<path>`; worktree recreated at `<path>`" into the first resumed turn                                                       |

## v2: in-app "Hand off to →" (deferred)

Client-mediated transport (no server↔server channel exists or is needed): the client connects to all environments simultaneously (`packages/client-runtime/src/connection/registry.ts:346-361`), so `handover.export` on the source + `handover.receive` on the target relay through the client. UI: per-thread context menu (`Sidebar.tsx` ~2181) submenu of environments sharing the thread's repository group (`apps/web/src/sidebarProjectGrouping.ts`, grouping via `deriveLogicalProjectKey`); gate the submenu on target provider availability at menu-build time; toast for success, dialog for failures (they're actionable multi-line instructions); "Interrupt and hand off" when running. Receive-side must be defensive (server-computed paths, UUID validation, size caps) since it is a "write into `~/.claude`/`~/.codex` + apply patch" primitive. Most v0 decisions carry over; remaining v2-only questions are UI copy and exact badge placement.

## Next steps

1. Write the `t3-session-handover` skill.
2. Verify end-to-end with a real working session across machines: clean tree, dirty tree, Case A and Case B worktrees, and the failure paths (missing commit, dirty target, oversized import).
