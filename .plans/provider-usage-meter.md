# Provider usage meter (subscription quota visibility)

Handover for an implementation session. Research and design direction below were
prepared in a prior session ("t3-fork-ideas") that surveyed ~100 public t3code forks.
This document is **not fully authoritative**: verified facts are labeled as such,
design choices are recommendations. You are expected to make your own calls where
reality disagrees with this file, and to ask the user when a decision genuinely
changes the product (not for routine engineering choices).

## Goal

Show live subscription-quota usage for Claude Code and Codex in the UI while the user
works. The user is on subscription plans for both providers (not API-key billing —
API cost display is explicitly out of scope). They want to see, at a glance, how much
of each rate-limit window remains and when it resets.

## Verified facts (checked against real code, July 2026)

### Data sources — no polling, no extra processes needed
- **Claude:** the Claude Agent SDK emits a `rate_limit_event` on the live session
  stream with `rate_limit_info` containing utilization and `resets_at`.
- **Codex:** the Codex app-server emits `account/rateLimits/updated` notifications
  with `primary`/`secondary` window objects (percent used + reset).
- Both arrive on session event streams our server already consumes. A fork that
  spawned a *second* `codex app-server` just to probe quota (maskdotdev) had auth/
  latency problems — don't do that.
- Providers without machine-readable quota (Cursor, OpenCode) should render nothing.
  Never fabricate a percentage.

### Reference implementation — tyulyukov/marcode (public GitHub fork)
The most portable prior art. Relevant files on its `main`:
- `apps/web/src/lib/providerUsage.ts` (+ `.test.ts`) — pure normalizer turning both
  providers' raw event shapes into a common `ProviderUsageSnapshot`
  (`windows: [{label, usedPercent, resetsAt}]`, `status: ok|warning|rejected`).
  ~250 lines, well tested. **This is the valuable part.** Port/adapt it — the payload
  shapes are undocumented and this encodes real debugging across ~10 hardening commits.
- `ProviderRuntimeIngestion.ts` changes — forwards the rate-limit activity kind from
  server to client. Small, additive.
- `apps/web/src/components/chat/ProviderUsageMeter.tsx` — the UI. **Do not port**
  (see design section). ~150 lines, cheap to redo.
- Relevant commits: `faba36032`, `a0f4979e1`, `dfda11375`, `6d0f8e0f8`, `56dce6a17`,
  `5a55350c1`. Skip `79124db10` (entangles usage recalc with a provider-upgrade
  advisory feature we don't want).
- Inspect via:
  `gh api "repos/tyulyukov/marcode/contents/<path>?ref=main" --jq .content | base64 -d`
  It's a renamed fork (`@marcode/contracts` etc.) — expect import-path translation.
  Do not copy blindly: adapt to our conventions (Effect Schema, our contracts
  package) and verify each payload-shape assumption against current CLI versions.

### Window taxonomy has CHANGED since marcode was written — verify, don't trust
marcode maps Claude `rate_limit_type` values `five_hour`, `seven_day`,
`seven_day_opus`, `seven_day_sonnet`. Per the user (July 2026), there is **no
separate Sonnet weekly limit anymore**; current Claude Code `/usage` shows:
- Current session (5h) — resets at an hour boundary
- Current week (all models)
- Current week (Fable) — the Fable/Mythos tier has its own weekly window

So the Opus/Sonnet split is stale and a Fable window exists that marcode never saw.
**Do not hardcode marcode's label map.** Verify the actual `rate_limit_type` strings
the current CLI emits (log a real event during development), map known types to
friendly labels, and pass unknown types through with a sane fallback label rather
than dropping them — the taxonomy will keep changing.

Also note from the real `/usage` output: reset timestamps are timezone-formatted, and
Anthropic sometimes attaches promo/extras info (e.g. "+50% weekly limits promo").
Rendering promo text is optional; ignore it in the payload gracefully if unmapped.

### Codex window quirks (reported by the user from live usage, July 2026)
- The 5-hour window is **sometimes absent** — Codex can report only a weekly limit
  (the user sees exactly this today). Render whatever windows are present; never
  assume both `primary` and `secondary` exist or that primary == 5h.
- Codex currently reports an extra **"GPT-5.3-Codex-Spark Weekly limit"** window.
  The user considers it an artefact (their Codex agent says it can't be disabled)
  and explicitly does NOT want to see it. **Filter it out** of the meter: suppress
  windows for the Spark model tier (match defensively — the label/type string may
  vary; don't hard-match one exact string). Keep the filter in one obvious place so
  it's easy to revisit. The user wants only: weekly, and the 5-hour window when it
  exists.

## Design direction (agreed with user — deviate with reason, ask if it changes UX)

marcode's UX: a bare bar-chart glyph in the composer status row; hover popover with
per-window bars, percentages, reset times. Critique the user agreed with:
1. Its color ramp tints the bar from ~0% (cyan→amber sweep starting immediately) —
   color stops meaning anything. **Ours: neutral/muted until ~70%, amber ≥70–80%,
   red/destructive ≥95%.** Color encodes exception, not position. (marcode's own
   status thresholds were warning ≥80 / rejected ≥98; reuse or tune, your call.)
2. Hover-only trigger with no number visible. **Ours: adaptive trigger** — below the
   warning threshold, a quiet glyph like marcode's; above it, the trigger expands
   inline to show the constrained window + percent (e.g. `5h 88%`). The UI reveals
   more as the situation worsens.
3. Status must not collapse to max() silently — when constrained, show WHICH window
   is constrained (session vs weekly vs Fable weekly). A hot 5h window and a hot
   weekly window demand opposite user responses.
4. **Threshold notifications:** fire a notification once when a window crosses the
   warning (~80%) and critical (~95%) thresholds. A separate work stream is building
   turn-completion notifications (settings toggles + Electron native notification
   IPC + Web Notification fallback); if that has landed on dev by the time you start,
   reuse its plumbing and settings pattern. If it hasn't, either coordinate or ship
   the meter without notifications and leave a clean seam. De-dupe: once per
   window per threshold crossing per reset period — don't re-fire every event.
5. Popover content: keep marcode's structure (per-window rows: label, percent, thin
   bar, reset time; "last updated" footer). It's good. Reset times in local time.
6. Placement: composer status row (near where a context/usage affordance naturally
   lives). If our composer layout makes this awkward, propose an alternative to the
   user rather than forcing it.

## Scope

- Web + desktop first. Mobile: the popover is hover-based — that doesn't exist on
  iOS. Mobile parity is desirable but optional in this pass; if the shared snapshot
  state lands in `packages/client-runtime`, a later mobile surface is cheap. Decide
  based on how much of the state layer you can keep platform-neutral.
- Both providers from day one (Claude + Codex). Others: render nothing.
- Setting to hide the meter entirely: nice-to-have, low priority.

## Constraints (fork policy — firm)

- This fork tracks upstream (pingdotgg/t3code) closely. Keep the change additive:
  new files + small surgical edits. **Do not** touch the orchestration decider/
  projector or add DB migrations — snapshots are ephemeral live state, not
  persisted history.
- Match repo conventions: Effect Schema in contracts, existing activity-ingestion
  patterns, existing settings schema pattern if you add a toggle.
- Never write a "Co-Authored-By: Claude" trailer in commits (a commit hook rejects
  it). lint-staged runs `vp fmt` on commit.
- Run typecheck + lint before calling it done; report the exact commands and output.

## Suggested first steps

1. Read how our server currently ingests provider runtime events and how activity
   kinds flow to the web client (find our equivalent of marcode's
   `ProviderRuntimeIngestion`).
2. Trigger a real Claude session and capture an actual `rate_limit_event` payload;
   same for Codex. This settles the window-taxonomy question empirically.
3. Then port/adapt the normalizer, then build the surface.

## Open questions (ask the user if the answer matters to what you ship)

- Whether the Fable weekly window should be visually distinguished from the
  all-models weekly window beyond its label.
- Whether threshold notifications should respect the same settings toggles as
  turn-completion notifications or have their own.
- Exact warning/critical thresholds (70/95 vs 80/98 — user hasn't pinned these).
- Whether the Spark-window filter should be a hardcoded suppression or a small
  settings-level "hidden windows" list (user only asked for Spark gone; hardcode is
  acceptable).
