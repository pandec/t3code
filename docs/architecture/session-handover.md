# Cross-machine session handover (proposal — not yet implemented)

Status: **design note / pickup document**. Feasibility empirically verified 2026-07-24; open product questions listed at the bottom. Nothing here is built yet.

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

Caveats found:

- Copy the whole `~/.claude/projects/<escaped-cwd>/` dir (may contain `memory/`), not just the `<uuid>.jsonl`.
- Session-scoped side state (todos, rewind/file-history checkpoints, shell snapshots, background shells) does not travel. Continuation is unaffected; rewind cannot reach back before the handover.
- Handover must be **one-shot/directional**: two machines resuming the same session id fork the transcript.

## Proposed design

### Transport: client-mediated (no server-to-server)

T3 has no server↔server channel and doesn't need one here. The web/desktop client already connects to **all** registered environments simultaneously (`packages/client-runtime/src/connection/registry.ts:346-361`, unbounded supervisor per environment). So:

- `handover.export(threadId)` on the source server → returns a package: provider transcript file(s), resume cursor + provider name, source cwd, HEAD sha + branch, patch of dirty tree (tracked + untracked).
- Client relays the package over its existing WS connections.
- `handover.receive(package)` on the target server → translates the home-relative path, places provider files (computing the target's escaped-cwd dir for Claude), verifies/applies git state, then drives the existing `sessionImport.import` path to create the thread.
- On success, source server marks the origin thread handed-off (archives it).

### UI: thread context menu

The sidebar already groups projects across environments by `RepositoryIdentity.canonicalKey` (`apps/web/src/sidebarProjectGrouping.ts`, `environmentPresence: "mixed"`). Add to the per-thread context menu (`Sidebar.tsx` ~2181, alongside Rename/Fork/Delete):

- **"Hand off to →"** submenu listing environments whose grouped project shares the thread's repository identity.
- Shows **"Interrupt and hand off"** when a turn is running (quiescence required).
- Progress toast during transfer; on completion the new thread appears under the target environment in the same sidebar group; source thread archived with a "handed off ↗" marker linking to the new thread.

### Recommended decisions (defaults unless overridden)

- **Provider scope v1**: Claude + Codex only (both verified). Cursor/Grok/OpenCode use the same cursor pattern but are untested.
- **Missing project on target**: if the repo exists at the translated path but isn't a T3 project, auto-create the project. If the repo is missing, fail clearly — no auto-cloning.
- **Handover note**: inject a short note into the first resumed turn ("this session was handed over; the repo now lives at `<path>`") — models self-correct anyway, but it's free insurance; cleaner than rewriting transcript JSON.
- **Expectation**: the received thread is a _new_ T3 thread built from the provider transcript. Provider-side history is complete; T3-native metadata (cost tallies, checkpoints/rewind) does not travel.

## Open product questions (decide before implementing)

1. **Uncommitted work policy.** Recommended: package records HEAD sha + branch + dirty-tree patch; receive applies only if the target repo is clean _and_ contains that commit; otherwise fail with a clear message ("push/pull first" / "target dirty"). No automatic commit syncing in v1 — git push/pull stays manual. Confirm, or choose a more/less aggressive policy (e.g. auto-stash on target, or push a temp WIP ref).
2. **Source thread fate.** Recommended: archive + "handed off" badge + link, strictly one-shot. Alternative (leave active with a divergence warning) is risky.
3. **Push vs pull.** Recommended v1: push ("Hand off to…" from the machine you're leaving). Pull ("grab this thread from space-mac" on arrival) as v2 — cheap later since transport is client-mediated either way. But note the pull direction is what saves you when you already closed the first laptop; decide if it should be v1 instead.
4. **Mid-turn handling.** Recommended: require quiescence, expose "Interrupt and hand off". Alternative: block entirely while running.
5. **Naming/UX details.** Keep thread title as-is? Toast vs. dialog for progress/errors? Where exactly the handed-off marker renders in the sidebar?

## Next steps

1. Answer open questions 1–4 (5 can be settled during implementation).
2. Write the implementation plan: contracts (`packages/contracts`) for `handover.export`/`handover.receive`, server handlers, client relay flow, sidebar menu + grouping lookup, archive/badge state.
3. Implement behind Claude+Codex scope; verify end-to-end space-mac ↔ ubuntu-dell with a real working session, including the dirty-tree path and the failure messages.
