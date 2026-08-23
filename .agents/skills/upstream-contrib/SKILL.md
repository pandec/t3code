---
name: upstream-contrib
description: Preview-first flow for contributing fork-found fixes upstream to pingdotgg/t3code, with a ledger for follow-up
disable-model-invocation: true
---

# Contribute upstream

Turn a verified fork-found bug into a merged upstream PR at `pingdotgg/t3code`. Every contribution gets a fork-side preview before anything touches upstream. `LEDGER.md` next to this file tracks state and lessons; update it on every state change.

## Fixed facts

- Upstream: `pingdotgg/t3code`. Fork: `pandec/t3code`. Local `main` is a clean upstream mirror; `dev` is fork-only.
- Contribution branches are `upstream/<slug>`, branched from local `main` in their own worktree. The diff must apply to upstream verbatim: zero fork concepts in code, tests, and prose.
- Bug inventory: `.plans/upstream-bugs.md` (gitignored, exists only on the maintainer's machine). Evidence behind this recipe: `.plans/upstream-contribution-analysis.md`, an 80-PR study of what upstream merges (2026-08-23). Consult it before changing the recipe.
- Preview PRs are draft PRs to `pandec/t3code:main`, for the maintainer's eyes only. They are never merged (`main` stays a mirror); close each once its upstream PR exists. Preview issues go to `pandec/t3code` issues.
- Screenshots are GitHub-hosted: pasting an image into a PR or issue body in the web UI uploads it and inserts a public link. `gh` cannot upload images, so preview bodies carry visible `[screenshot placeholder: ...]` lines for the maintainer to fill in the browser.

## Recipe

1. **Pick and rank.** From the bug inventory, prefer fixes under 100 LOC touching 1-3 files with a deterministic failure scenario. One bug per PR.
2. **Dedupe.** Before implementing, delegate a search of upstream PRs and issues (open and closed, keywords plus file paths) to a luna agent. A match on the same fix ends the attempt; related items become links in the PR body. Note the result in the ledger.
3. **Issue or PR.** File an issue (preview first) when it adds information upstream needs: a design decision, ambiguous expected behavior, a cross-client bug, or a fix likely over 100 LOC. A small self-evident bug goes straight to PR with the failure scenario in its body.
4. **Implement** in a fresh worktree on `upstream/<slug>`. Smallest correct shape, following the worktree's own AGENTS.md (it is pure upstream). Include a focused regression test and prove it gates the fix: break the source once, watch it fail, restore.
5. **Verify.** Focused tests for the changed behavior, targeted lint, then `vp check` and `vp run typecheck` in the worktree.
6. **Preview PR.** Push the branch to origin, open a draft PR to `pandec:main` titled exactly as the upstream PR will be. Body: failure scenario, root cause, the fix, verification, related upstream links from step 2, screenshot placeholders, and the model/harness line upstream's AGENTS.md asks for. Then a review pass (opus plus sol-high), fixing findings.
7. **Handoff.** The maintainer reviews each preview, pastes screenshots, and approves it for upstream, one at a time.
8. **Upstream PR** from the maintainer's public fork of upstream, then close the preview. Record the open date in the ledger.
9. **Babysit.** `status.sh` in this directory shows all preview and upstream states. On the upstream PR: fix valid bot findings promptly, refute false positives with a concrete reason, push follow-ups while the PR is warm. Stop rule: untouched for 30 days means rebase once, leave one concise update, keep the fork patch, move on.
10. **Record.** Update the ledger: state, dates, time to first bot review, time to first human touch, whether the merge was silent, and any lesson worth changing this recipe for.
