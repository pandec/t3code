# AGENTS.md

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Keep additional verification focused on the files and packages changed.
  - Use `vp test run <test-files>` for focused built-in Vite+ tests. Use `vp run test` only when the affected package specifically requires its `test` script.
  - Backend changes must include and run focused tests for the changed behavior.
  - Run targeted formatting, lint, and type checks for the affected scope when available.
- After frontend feature development or any user-visible frontend behavior change, the primary agent must run one integrated verification pass for each affected client surface after integrating the work:
  - Web: use the `test-t3-app` skill. Launch one isolated environment, authenticate through the printed pairing URL, and verify the affected flow in the controlled browser.
  - Mobile: use the `test-t3-mobile` skill. Connect one representative iOS Simulator or Android Emulator available on the host to one isolated environment and verify the affected flow. On compatible macOS hosts, prefer iOS for cross-platform changes and stream it through serve-sim in the T3 Code in-app browser or another available agent browser; use Android when it is the affected or viable platform.
  - Subagents must not independently launch dev servers or repeat integrated client verification unless their delegated task explicitly requires it.
  - Stop dev servers, watchers, and other long-running verification processes when the focused verification is complete.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Private Fork Change Policy

This checkout is a private development build that should remain easy to synchronize with the upstream
repository. Prefer narrow, localized changes that reuse existing extension points and avoid unrelated
refactors, broad formatting churn, generated-file edits, or architectural rewrites that would make future
upstream merges harder. Add only the most important focused tests for private customizations; do not build
out production-grade test matrices unless the change is unusually risky. The task completion checks above
still apply.

When this policy conflicts with the broader maintainability guidance above, prefer the narrower change that
reduces future upstream merge cost, even when a wider refactor would be architecturally cleaner.

Treat local verification as a prerequisite to pushing fork-development branches and opening or updating
pull requests. Run the task completion checks above plus every additional locally runnable check relevant
to the affected scope, and push the branch only after the applicable checks pass. Use the pull request for
review and integration, not as a substitute for pre-push verification.

Use `dev` as the fork's primary integration and build branch. Commit private fork work to `dev`, base
fork-specific feature branches and worktrees on `dev`, and merge completed work back into `dev`. Keep `main`
as a clean mirror of `upstream/main` for synchronization only: do not develop, build fork releases, or commit
private changes directly on `main`. To incorporate upstream changes, first fast-forward `main` from
`upstream/main`, then merge or rebase that synchronized state into `dev` and resolve conflicts there. Before
editing, committing, or producing a fork build, verify that the active branch is `dev` or a branch based on
`dev`.

## Private Build Helpers

Personal shell helpers from `~/.dotfiles` operate on this checkout at
`~/SynologyDrive/AIMac/repos/t3code`. Run them from a shell with the dotfiles loaded; `qh` shows the current
platform-specific list.

- `t3-build`: build the packaged Dev desktop artifact (DMG on macOS, AppImage on Ubuntu).
- `t3-install-desktop`: build and replace the installed T3 Code Dev desktop app, preserving its existing
  application data.
- `t3-dev` (macOS): run the Electron desktop app directly from source for development checks.
- `t3-run` / `qt3`: launch or restart the installed packaged Dev desktop app.
- `t3-install-ios` (macOS): build and install the self-contained iOS release on a connected iPhone.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
