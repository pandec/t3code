# Fork-local setup facts

Fork-specific and machine-specific facts for `test-t3-mobile`. Never upstream this file; the sync-upstream LEDGER records how to reconcile the skill on sync.

## Bundle identifier override (active on this fork)

Root `.env.local` sets `T3CODE_IOS_BUNDLE_ID=com.pandec.tools.t3code` with `T3CODE_APPLE_TEAM_ID=2BY9VZMTHG` and `T3CODE_IOS_PERSONAL_TEAM=0`. Consequences:

- Every iOS variant on this machine builds as `com.pandec.tools.t3code` (widgets: `.widgets`, sharing: `.sharing`). The skill's default `com.t3tools.t3code.dev` never matches an installed app here.
- The URL scheme stays `t3code-dev` for development builds regardless of the override — which is exactly why scheme-based `simctl openurl` can hit the wrong app.
- Android is unaffected: the package remains `com.t3tools.t3code.dev`.

## Workspace naming — last prebuild wins

The main checkout usually holds `T3Code.xcworkspace` / scheme `T3Code`, because the habitual device command (`vp run ios:local:release`) runs a **production** prebuild. A development prebuild replaces it with `T3CodeDev.xcworkspace` / scheme `T3CodeDev`. Always `ls -d apps/mobile/ios/*.xcworkspace` before setting XcodeBuildMCP defaults; fresh worktrees have no `ios/` directory at all.

## Known `t3code-dev` scheme collider

`vp run ios:local` combines `APP_VARIANT=development` (scheme `t3code-dev`, name "T3 Code Dev") with the custom bundle id — producing an app that looks identical to the standard dev client but is `com.pandec.tools.t3code`. After any `openurl`, confirm which bundle id actually handled the URL before trusting UI state.

## Seeding project accent colors (fork feature)

Accent colors live in `<base-dir>/userdata/settings.json` under `projectAccentColors`, keyed by the project's accent key: the repository identity's `canonicalKey` (e.g. `github.com/pingdotgg/t3code`) whenever the project has a git remote — which every `scripts/mobile-showcase-environment.ts` fixture project does — and the normalized workspace path only for non-git projects. Seeding with path keys for git projects silently renders nothing: pairing works, the config carries the colors, but no row ever matches. Confirm the keys the client actually derives from its cache (`client_cache` kind `shell` → `snapshot.projects[].repositoryIdentity.canonicalKey`) instead of guessing, and edit `settings.json` only while the backend is stopped. Restarting the backend while the app is connected delivers the new colors on reconnect, which doubles as a live-update check.

## Simulator UI traps

- The floating Expo dev-menu bubble sits directly over the thread list's settings gear, so a semantic tap on "Open settings" opens the developer menu instead. Use the `t3code-dev://settings` deep link (and other `linking:` routes from `Stack.tsx`) rather than fighting the overlay.
- XcodeBuildMCP cannot drag slider thumbs (`FBSimulatorHIDEvent does not support touch move events`) and sliders reject `swipe`. A `tap` on the slider element sets it to its center value — enough to prove a settings slider writes, not enough to reach an extreme.

## Physical iPhone

- Install path: `vp run ios:local:release` = production, Release, `--no-bundler`. Embedded JS bundle; Metro and dev-client URLs do not apply.
- Signing: team `2BY9VZMTHG` must be signed into Xcode once per machine, interactively (never over SSH). `No Account for Team` means this machine's Xcode account state, not a source problem.

## Which machine runs simulators

- **SpaceMac is the simulator host.** Run iOS Simulator work there by default, reaching it over the `space-mac` SSH alias (tailnet) and driving it through its own T3 server.
- **GreyMac (`GreyMac.local`) has much less RAM than SpaceMac.** Do not boot a simulator here unless the user asks for it on this machine in the current conversation — not even to "quickly check" something. A running virtual device starves the apps they are working in.
- Android emulators are not part of this fork's workflow and are heavier than an iOS Simulator besides. Do not start one on GreyMac either.
- **Builds are not gated anywhere.** Clean prebuild, full native builds, and Expo/EAS builds are all fine on GreyMac. Run them where asked and do not suggest moving them to SpaceMac — a build requested here usually means SpaceMac is not currently an option (for example, producing a TestFlight build while away from it).
- A physical iPhone attached to the local machine is likewise unaffected.

## Host quirks

- `vp run lint:mobile` detekt exits 126: the Homebrew detekt wrapper points at a removed JDK 17. Run `JAVA_HOME=$(/usr/libexec/java_home -v 21) vp run lint:mobile`.
- The Codex sandbox rejects `rm -rf`. Move disposable base directories to the trash instead (`mv <base-dir> ~/.Trash/` or `/usr/bin/trash`); do not escalate permissions for cleanup.
