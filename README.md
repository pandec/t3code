# T3 Code — pandec fork

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Everything about the base project — what T3 Code is, installation, documentation, and contributing — is covered by the [upstream README](https://github.com/pingdotgg/t3code#readme). This file only documents what the fork adds on top. Upstream's project-icon customization is covered in [project settings](./docs/user/project-settings.md).

## Branches

- **`dev`** — the fork. All fork work lands here; this is the branch you want.
- **`main`** — a clean mirror of `pingdotgg/t3code`, deliberately kept free of fork commits so it can be fast-forwarded on every upstream sync. Synced `main` is merged into `dev` regularly.

## What the fork adds

- **Open threads from links.** The desktop app opens `t3code://app/<environmentId>/<threadId>` links (`t3code-dev://` for Dev builds) from other apps, whether it is already running or starts from the link. Use `primary` as the environment ID for the desktop's own environment. Archived threads open too, with an archived notice and an Unarchive button above the composer. A link to an unknown environment or thread shows a short error instead.

### Conversations & threads

- **Linear issue panel** — on web and desktop, a `linear.app/<workspace>/issue/KEY-123` link in any message opens the issue as a tab in the right panel instead of the browser, and bare identifiers like `SP-123` do the same for the team keys you list. The tab shows the title, description, and comments, with the issue's properties as a row of chips that use Linear's own status and priority glyphs; the assignee, creator, project, and team open their Linear pages, and the parent, sub-issues, blocking and related issues, and attached links each get a section when the issue has them. Sub-issues and relations open as further tabs, the git branch name copies with one click, it refreshes on demand, and you can post a comment. Unsent comments survive tab switches within the same browser session; hovering a link shows a preview card. The personal API key (stored server-side, one per environment) and the team keys live in Settings → Extras → Linear. Mobile keeps opening these links in the system browser.
- **File path actions.** The open-in menu on a file tab ends with Reveal in Finder (File Explorer or Files on other hosts), Copy relative path, and Copy full path. Right-clicking the file name in the breadcrumb, the file tab, a file in the tree, or a diff header offers the same copy pair. Reveal, and the right-click menu's Open and Open with, only appear while you are on the machine that hosts the environment, since launching an app on another computer helps nobody. The menu's default-app entry is now called "Default app" rather than "Finder", because a file opens in whatever app owns its type.
- **Saved prompt library** — reusable prompts (title + content) managed in Settings → Prompts and synced across connected environments with whole-library last-write-wins, including catch-up for environments that were offline during an edit. `/prompt` in the composer opens a filterable picker (titles and content previews) that inserts the prompt at the cursor without sending; the command palette's **Prompts...** submenu inserts the selected prompt into the composer on Enter and copies it on Cmd+Enter on macOS or Ctrl+Enter on Windows and Linux.
- **Gateway-aware usage attribution** — the Usage page can credit each model to the subscription it actually spends rather than to the transcript it was found in. A Claude Code session that a CLIProxyAPI gateway routed to an OpenAI model counts towards Codex, and a Codex session that reached an Anthropic model counts towards Claude Code, so one model no longer appears as two rows split between the providers. A "By subscription" / "By app" toggle in the page header switches between that pool view and grouping by the app whose transcripts recorded the usage (all Claude Code activity as one row); the choice is remembered per device. Spend and tokens regroup exactly either way — every response belongs to one row in each view — while per-row session counts appear only in the app view, because a single session can spend from both pools and cannot be split honestly. The correction is applied when the page merges each environment's answer, so it also covers environments running an older server.
- **OpenRouter credit balance** — the usage meter popover can show your remaining OpenRouter credits. Opt in under Settings → Extras → Provider usage and paste an OpenRouter management key (created at openrouter.ai/settings/management-keys; the credits endpoint rejects regular inference keys) once; the key is applied to every connected environment, stored in each environment's secret store, and used server-side to read `GET /api/v1/credits` with a one-minute cache. A failed read keeps the last balance on screen with the reason under it, the settings page lists each environment's stored-key state and current balance, and the reset button on the key row removes the key everywhere. An optional budget (the balance you started from) turns the balance into a spend bar with the same warning and critical colours as provider quotas. The row sits last in the popover's scrollable account list rather than pinned above the context window. Web and desktop only.
- **Message font** — Settings → Appearance → Typography (Advanced) adds a Message font row beside the Prompt font. It sets the family and pixel size of agent replies and your own messages in the thread. The interface size is untouched, so the conversation can run at 18px while the sidebar and tool rows keep the interface size. Markdown headings, inline code, tables, and footnotes inside messages scale with it. Web and desktop only.
- **Terminal close confirmation** — upstream asks before every individual terminal close. Settings → General adds a switch that turns the prompt off; it stays on by default, and bulk tab closes and auto-exit cleanup never prompted either way.

### Voice

- **Voice dictation** — ElevenLabs-powered voice transcription in the web and desktop composer. On mobile it backs the dictation control as the fallback wherever Apple's on-device transcription is unavailable (Android, older iOS, unsupported locales), so every device keeps a working mic.

### Agents & skills

- **Home-relative provider binaries** — explicit Binary path settings for Cursor, Grok, and OpenCode accept `~` or `~/…`; T3 expands them against the server user's home directory at runtime without rewriting the saved setting.
- **Custom model display labels.** Give custom models a name in provider settings. Existing `slug=Label` entries still load with the label shown in the picker and the bare slug sent to the provider.
- **Custom model icons** — each custom model on a provider instance can carry one of the built-in glyphs (Codex, Claude, OpenCode, Cursor, Grok, Antigravity, plus Z.ai for GLM models), picked per model in the instance's Models settings. The icon replaces the driver's glyph in the model picker list and composer trigger, so a gateway-served model (e.g. a Codex model behind a Claude provider instance) reads as its real model family at a glance; the instance accent color and badge stay unchanged. Overrides live in the instance config (`customModelIcons`, keyed by the bare slug), so they follow the instance and never leak between instances of the same driver.

### CLI & automation

### Reliability

- A saved environment's label or URL can be edited without re-pairing — the stored pairing token survives the edit.
- Escalating desktop process termination and an interactive sidebar resize rail.

### Fork infrastructure

- **Dev app flavor** — a separate Dev flavor of the desktop app with isolated state directories
  (shared provider homes), a Linux Dev AppImage build, personal-team iOS builds, and
  [internal TestFlight uploads](apps/mobile/README.md#testflight) for the fork's production app.
  macOS Dev builds require a verified Developer ID signature so permission grants can survive
  rebuilds. See [local signing setup](docs/operations/development.md#signed-macos-dev-builds).
  Remote Mac builds can automatically unlock a dedicated signing keychain.
- **Fleet updater** — `pnpm update:machines` updates the fork's dev machines, local and remote, in one pass: pick targets interactively or name them (`--host`, `--include-local-desktop`, `--include-local-ios`), see dirty or off-branch checkouts before rebuilding and cancel or continue the eligible remainder, build the local desktop and iPhone at the same time, let Expo prompt when a local iPhone needs unlocking, rehearse with `--dry-run`, and reread captured failures with `--show-failure-logs`.
- **Upstream sync workflow** — a scripted `sync-upstream` flow that fast-forwards the `main` mirror from upstream, merges it into `dev`, and runs the required checks before pushing. `scripts/check-upstream-sync.sh` reports whether a sync is due; it is also offered as the **Check Upstream Sync** action in `t3.json`.
