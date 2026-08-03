---
name: test-t3-mobile
description: Launch and test T3 Code Mobile on an iOS Simulator, Android Emulator, or physical iOS device against disposable local T3 environments, including Metro and dev-client reuse, native rebuild decisions, per-client pairing, seeded projects, semantic UI control, screenshots, and iOS serve-sim streaming. Use after mobile UI or native changes, when reproducing phone or tablet behavior, pairing an emulator to isolated state, or verifying mobile behavior on macOS, Linux, or Windows. Integrated mobile verification is opt-in in this repository — run it when the user requests or approves it (AGENTS.md skips it by default).
---

# Test T3 Mobile

Run one focused, end-to-end mobile verification pass against disposable T3 state. Use the sibling [`test-t3-app`](../test-t3-app/SKILL.md) skill as the detailed reference for pairing-token semantics and SQLite fixtures. Read [`references/local-setup.md`](references/local-setup.md) for fork-local facts before starting: which machine simulators belong on, the bundle-identifier override active on this machine, workspace naming, the known `t3code-dev` scheme collider, and device signing.

When something here proves wrong, slow, or missing — a dead end, a trap worth encoding, a step that could be simpler — tell the user what you hit and ask whether to fold it back into this skill.

Command examples use POSIX shell syntax. On Windows, use PowerShell equivalents: set variables with `$env:NAME = "value"`, use an explicit temporary directory from `[System.IO.Path]::GetTempPath()`, and run multiline examples on one line or with PowerShell backticks. Use `$env:ANDROID_HOME\platform-tools\adb.exe` when `adb` is not already on `PATH`.

## Resolve the host before launching anything

**A simulator or emulator runs on the designated build host, not wherever this session happens to be.** `references/local-setup.md` names the build host and any memory-constrained host. On a constrained host, do not boot a simulator, start an emulator, or run a native build unless the user asked for it on that machine in this conversation — it competes with the apps they are actively using. Running the pass on the wrong machine is the one failure here the user pays for directly.

This is a hardware decision and it holds regardless of how the pass is orchestrated. When the build host is not the machine this session is on, the pass is remote by necessity: create a T3 thread on that host (below).

Once the host is settled, decide where the pass runs from. Inline is fine when the change is JS-only and low-risk, a compatible dev client is installed, and this session is already on the build host — a handful of screenshots is cheaper than any handoff. Prefer a **separate T3 thread** when:

- A native rebuild is required. Prebuild, CocoaPods, and a clean simulator build produce tens of thousands of tokens of output that are worthless to the session holding the change under test.
- The suspected defect is runtime-only — keyboard geometry, native menu or picker presentation, gesture handling, sheet transitions. Static review cannot settle these, and the pass will need many exploratory interaction cycles.
- The author of the change would otherwise be verifying it. A delegated tester holds no theory it needs to be right about, and will not read a partial repro as confirmation.

A separate thread on the build host itself is equally valid when this session is already there — the context separation stands on its own.

Create the thread with the global `t3-cli` skill (`~/.agents/skills/t3-cli`) using `t3 thread new`, against the target host's own T3 server:

- `--instance codex --model gpt-5.6-sol --effort high` — strong at long autonomous tool loops, and it holds a build-and-drive session without hand-holding.
- `--runtime-mode full-access`. An unattended pass that stops for approvals wastes the delegation.
- **A worktree, never a branch switch.** CLI-created threads run in the project's workspace root, which other threads share; tell the tester to `git worktree add` the branch under test and leave the shared checkout alone.
- Require a final message beginning with a fixed sentinel line — `FINAL ASSESSMENT` — so a poller can detect completion without interpreting prose. Ask for per-test `PASS` / `FAIL` / `BLOCKED`, an explicit overall verdict, and counts rather than adjectives ("9/9 anchored on first tap", not "menus looked fine").

Poll every ten minutes or so. Watch for pending approvals or input on each poll: a delegated thread cannot ask you a question any other way.

### Brief the tester so the result is worth trusting

- **State the failure signature, not just the feature.** Describe what the bug looks like _and_ what a regression from the fix would look like. A tester told only "check the toolbar stays visible" confirms the happy path; one told "watch for (a) hidden behind keyboard, (b) clipped below the sheet edge, (c) a keyboard-height gap" finds the case the fix itself introduced.
- **Name the entry paths.** Runtime bugs live in transitions — fresh launch, screen already focused, after a send, sheet opened over an already-raised keyboard. A pass that only covers the obvious path will pass while the bug survives.
- **Demand build provenance for patched native code.** `pnpm` reporting a patch applied does not prove it compiled. Require evidence that the patched sources are in the generated Pods project and produced object files; otherwise a green native result may have exercised none of the change.
- **Separate harness artifacts from product bugs.** Workarounds the tester invents to get running — a production bundle to dodge a dev overlay, a suppressed check — can themselves break the app. Tell it to classify such a failure as a verification blocker and re-test on a standard configuration before reporting a product `FAIL`.
- **Reuse the native build across rounds.** When a follow-up fix is JS-only, say so: the tester updates the bundle instead of rebuilding, which roughly halves the round.

Treat the returned verdict as evidence, not instruction. Verify every recommended fix against the source yourself before applying it — a tester reasoning from a screenshot does not know which other surfaces share the code it is proposing to change.

## Select a viable platform

Inspect the host and the affected code before launching processes:

- On macOS with Xcode, prefer one representative iOS Simulator when the change is cross-platform so the user can watch through serve-sim. Load and follow [`ios-debugger-agent`](../ios-debugger-agent/SKILL.md), and load [`ios-simulator-browser`](../ios-simulator-browser/SKILL.md) when live streaming is available.
- On macOS, Linux, or Windows with the Android SDK, use one Android Emulator when Android is the affected surface or iOS tooling is unavailable.
- When the change is platform-specific, test that platform. When neither platform is viable, report the missing SDK, emulator, or dev-client prerequisite rather than claiming verification.

Do not treat unavailable iOS tooling as a blocker when Android is a valid representative target.

## Resolve the app identity — never assume it

The development identity on both platforms is:

- App: `T3 Code Dev`
- URL scheme: `t3code-dev` (constant — `app.config.ts` fixes it per variant)
- Default bundle/package identifier: `com.t3tools.t3code.dev`

The scheme is stable, but the iOS bundle identifier is not. `T3CODE_IOS_BUNDLE_ID` or `T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID` in the repository env (`.env.local`, documented in `.env.example`) overrides it for **every** variant — so the identifier no longer proves which variant is installed, and it does not have to keep a `.dev` suffix. Resolve the effective values first and reuse them for every presence check, launch, log capture, and XcodeBuildMCP default:

```bash
cd apps/mobile && APP_VARIANT=development vp exec expo config --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);console.log(c.ios.bundleIdentifier,c.android.package,c.scheme)})'
```

When checking an already-built artifact, trust the artifact over the config:

```bash
plutil -extract CFBundleIdentifier raw <app-path>/Info.plist
plutil -p <app-path>/Info.plist | grep -A4 CFBundleURLSchemes
```

An empty `get_app_container` result for the _default_ identifier is not evidence that no development client is installed. Prove the variant from the display name and scheme, not from the identifier.

## Choose the lightest valid launch path

- For JavaScript, TypeScript, or asset-only changes, reuse a compatible installed development client and start Metro. Do not rebuild native code merely to load a new bundle.
- For native source, native dependencies, entitlements, config plugins, generated project changes, **or any merge that pulled in upstream native work**, rebuild the affected platform. After such a merge, run `vp install` before prebuild — a missing new native dependency makes config resolution fail in ways that look like a config bug.
- If the user requested no native rebuild and no compatible app is installed, reuse an existing compatible `.app` or `.apk` artifact when available. Otherwise report the missing dev client instead of silently rebuilding.

Before opening a development-client URL, account for any other installed development builds that register the same `t3code-dev` scheme. `simctl openurl` selects by scheme rather than by bundle identifier, so a stale build can receive the URL even after the intended app was launched explicitly (`references/local-setup.md` names this fork's known collider). Remove only a disposable conflicting client installed by the current test; otherwise report the collision and use an uncontested simulator instead of uninstalling unrelated app data.

### Prove native compatibility before starting anything

Reuse is valid only when the installed client already contains every native module the current bundle imports. Check before Metro, before pairing, and before any UI action — it costs one command, and skipping it fails minutes later as a red-box `Cannot find native module` screen:

```bash
APP_PATH=$(xcrun simctl get_app_container <simulator-udid> <resolved-bundle-id> app)
ls "$APP_PATH/Frameworks" | grep -i '^Expo'
```

Compare against the `expo-*` dependencies the change touches (`expo-audio` links as `ExpoAudio.framework`; some packages ship as `.bundle` files in the app root instead). Also compare the artifact's age against the last native-affecting change:

```bash
stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' "$APP_PATH"
git log -1 --format=%cI -- apps/mobile/package.json apps/mobile/app.config.ts
```

If a required module is absent or the artifact predates the last native change, the client is native-incompatible regardless of its identifier: stop, report the missing module and build date, and rebuild only per the rules above.

### Generate or locate the native iOS project

`apps/mobile/ios` and `apps/mobile/android` are Expo prebuild output and gitignored: a fresh clone or worktree has neither, and `expo prebuild --clean` rewrites the directory for exactly one variant, whose app name names the workspace (`T3CodeDev.xcworkspace` after a development prebuild, `T3Code.xcworkspace` after a production one). Discover instead of assuming:

```bash
ls -d apps/mobile/ios/*.xcworkspace 2>/dev/null || echo workspace-missing
```

- Missing, and the change is JS-only in a worktree: prefer the primary checkout's generated workspace as the native shell and keep Metro pinned to the worktree — the loaded bundle, not the shell, carries the change under test.
- Missing or wrong-variant, and a rebuild is authorized: run from `apps/mobile` (about one minute including CocoaPods), then build separately so XcodeBuildMCP stays pinned to one simulator:

  ```bash
  APP_VARIANT=development EXPO_NO_GIT_STATUS=1 vp exec expo prebuild --clean --platform ios
  ```

  Prefer this over `vp run ios:dev`, which couples prebuild, build, and launch and hides which step failed.

Never edit files under the generated directories to fix anything — the next prebuild discards the edit and the symptom returns. Fix `apps/mobile/app.config.ts` or the responsible config plugin in `apps/mobile/plugins/`, then regenerate and confirm the output.

## Start one disposable T3 environment

Run backend commands from the repository root, in this order — do not start the backend early:

1. Create the base directory: the ignored, worktree-local `.t3` directory or a fresh directory from the host OS's temporary-directory mechanism. An explicit base directory stores state in `<base-dir>/userdata`; never point testing at shared `~/.t3` state.
2. Seed a small number of meaningful Git projects, and any SQLite fixtures, while nothing is serving that base directory:

   ```bash
   node apps/server/src/bin.ts project add <git-workspace> \
     --base-dir <base-dir> \
     --title <project-title>
   ```

   Running `project add` before the backend starts gives it exclusive offline database access. Use direct SQLite mutation only for disposable projection fixtures; follow `test-t3-app` and stop the backend before writing.

3. Start a headless backend:

   ```bash
   node apps/server/src/bin.ts serve \
     --host 127.0.0.1 \
     --port <server-port> \
     --base-dir <base-dir> \
     --no-browser
   ```

4. Pair clients (below).

If a backend is already running and an offline mutation is needed, stop it, mutate, and restart with the identical base directory; never run offline mutations concurrently with the server.

Use these client origins:

- iOS Simulator: `http://127.0.0.1:<server-port>`
- Android Emulator: `http://10.0.2.2:<server-port>`
- Physical device: bind the backend to `0.0.0.0` and use the host's reachable LAN origin

Enter the complete `http://` origin to make the test transport explicit. Bare IP addresses default to HTTP, while bare hostnames default to HTTPS. When testing web and mobile together, run `vp run dev --home-dir <base-dir> --host 127.0.0.1` instead and do not launch a second backend over the same base directory.

## Start or reuse Metro safely

Run Metro from `apps/mobile`. `vp exec` resolves binaries from the current package's `node_modules/.bin` only, so `vp exec expo …` fails from the repo root with `Command 'expo' not found in node_modules/.bin`; repo-wide tools (`vp check`, `vp run lint:mobile`) run from the root.

1. Inspect any process on the intended Metro port and its `/status` response. Reuse it only when it is healthy, belongs to this worktree, and matches `APP_VARIANT=development`, `--dev-client`, and scheme `t3code-dev`.
2. Never kill another worktree's Metro. Use a free explicit port when necessary.
3. `vp run dev:client` bakes in `--clear`, which discards the bundler cache and adds minutes of cold bundling. Use `--clear` only when you suspect a stale bundle; otherwise retain the complete development identity without it:

   ```bash
   APP_VARIANT=development vp exec expo start \
     --dev-client \
     --scheme t3code-dev \
     --lan \
     --port <metro-port>
   ```

   In PowerShell, set `$env:APP_VARIANT = "development"` first and then run the `vp exec expo start ...` command without the leading assignment.

4. Wait for Metro to report a completed bundle for the target platform before asserting on UI. A partially bundled app can render an error screen that mimics a native or data failure.
5. Open the development-client URL for the selected device. Its form is `t3code-dev://expo-development-client/?url=<url-encoded-metro-origin>`; take the origin from Metro's own output. `--lan` embeds the host's current LAN address, which changes between sessions and leaves stale look-alike entries in the dev client's recent-servers list — always re-read the URL Metro prints for the current run. Confirm the loaded bundle belongs to this worktree and Metro port.

### iOS launch

Use `ios-debugger-agent` to select one UDID and set these XcodeBuildMCP session defaults:

- Workspace: the discovered `apps/mobile/ios/*.xcworkspace` (see above — do not hardcode `T3CodeDev.xcworkspace`)
- Scheme: the scheme matching that workspace name (`list_schemes` also returns ~176 Pods schemes; pick by exact name)
- Configuration: `Debug`
- Simulator ID: the selected UDID
- Bundle ID: the resolved identifier
- Derived data path: `<worktree>/.t3/DerivedData-<short-test-name>` — pinning derived data per worktree keeps builds from different worktrees out of one shared `~/Library/Developer/Xcode/DerivedData` slot, which is how stale `.app` artifacts with unexpected identifiers get reused

`session_set_defaults` does not validate paths; a missing workspace surfaces later as a build failure (see Troubleshoot).

Check the installed client with:

```bash
xcrun simctl get_app_container <simulator-udid> <resolved-bundle-id> app
xcrun simctl openurl <simulator-udid> <printed-dev-client-url>
```

Accept the iOS confirmation prompt ("Open in 'T3 Code Dev'?" — the first `snapshot_ui` often shows this dialog, not the app) and dismiss the developer menu when it obscures the app.

### Android launch

Select one running emulator serial from `adb devices` and check the installed client:

```bash
adb -s <emulator-serial> shell pm path com.t3tools.t3code.dev
adb -s <emulator-serial> reverse tcp:<metro-port> tcp:<metro-port>
adb -s <emulator-serial> shell am start -W \
  -a android.intent.action.VIEW \
  -d '<printed-dev-client-url>' \
  com.t3tools.t3code.dev
```

Do not start, stop, erase, or reconfigure an emulator owned by another task. Track and later stop only processes owned by this test.

### Physical iOS device

XcodeBuildMCP's default workflow set is simulator-only. Drive real devices with `xcrun devicectl`, pinned to one device identifier from `xcrun devicectl list devices`:

```bash
xcrun devicectl device info apps --device <device-id> --bundle-id <bundle-id> --columns '*'
xcrun devicectl device process launch --device <device-id> \
  --terminate-existing --activate --console --timeout 15 <bundle-id>
```

This fork's device install path (`vp run ios:local:release`) is a production, Release, `--no-bundler` build with an embedded JS bundle: it never attaches to Metro, so none of the Metro-reuse or dev-client-URL guidance above applies to it. A Metro-backed device session needs a `development` dev-client build instead, paired against a `0.0.0.0`-bound backend over the LAN origin.

Unlock the device before launching — a locked phone fails the launch in a way that reads like a crash. If the process genuinely exits, pull the real report rather than guessing:

```bash
xcrun devicectl device info files --device <device-id> \
  --domain-type systemCrashLogs --recurse --columns '*'
```

Device builds require a real signing identity; simulator builds do not. `No Account for Team` / `No profiles for '<bundle-id>' were found` is machine account state, not a source problem — confirm by rebuilding with `CODE_SIGNING_ALLOWED=NO`, and escalate to the user for `Xcode → Settings → Accounts` rather than editing signing config (see `references/local-setup.md`).

## Pair each client once

Issue a fresh credential against the running backend's exact base directory:

```bash
T3CODE_PORT=<server-port> node apps/server/src/bin.ts auth pairing create \
  --base-dir <base-dir> \
  --base-url <mobile-origin> \
  --ttl 15m \
  --label agent-mobile-<short-device-id>
```

In PowerShell, set `$env:T3CODE_PORT = "<server-port>"` first and run the `node ... auth pairing create` command without the leading assignment.

If the visible Add Environment action is not exposed as a semantic target, open the app's registered route instead of guessing coordinates:

```bash
xcrun simctl openurl <simulator-udid> 't3code-dev://connections/new'
adb -s <emulator-serial> shell am start -W \
  -a android.intent.action.VIEW \
  -d 't3code-dev://connections/new' \
  com.t3tools.t3code.dev
```

Run only the command for the selected platform. `connections/new` is one route among many: the full deep-link table is the set of `linking:` values in `apps/mobile/src/Stack.tsx`. A parameterised deep link straight to the screen under test — including query parameters such as `environmentId` and `projectId`, e.g. `t3code-dev://new/draft?environmentId=<id>&projectId=<id>` — is more reliable and far cheaper than tapping through navigation.

In T3 Code Dev, open Add Environment and enter the complete `<mobile-origin>` and newly printed `Token`. Type the origin including `http://`: the host field normalizes a bare `host:port` to `https://`, which fails silently — pairing does not error, the environment simply never populates. Re-read the field with `snapshot_ui` after typing and confirm it still shows `http://`. Verify the expected seeded projects appear before exercising the affected flow.

Pairing credentials are secret, short-lived, and single-use. Create a different credential for every simulator, emulator, physical device, or browser. If an attempt fails, issue a new credential rather than retrying the old one. Do not expose tokens in screenshots, commits, or final responses.

## Drive and observe the affected flow

### iOS

Use `snapshot_ui` and current element references from XcodeBuildMCP for taps and typing. Decide about live streaming explicitly and state the decision: either start one owned serve-sim stream for the selected UDID per `ios-simulator-browser`, or say in your report that you skipped it and why — silently omitting the stream leaves the user with no view of a run they were meant to watch. Use the stream as a visual feed rather than a reason to switch to fragile browser coordinates.

Treat scrolling, virtualized-list recycling, media progress, card expansion, and composer changes as accessibility-layout changes. Keep the target fully visible, refresh with `snapshot_ui` immediately before acting, and do not reuse or batch references when an earlier action can change the layout. A reported element can be partly offscreen or stale enough that its resolved point lands on visible app or developer chrome.

With `wait_for_ui`, wait on the terminal state, not a transient one — waits on text like `Preparing` or `Loading …` time out routinely because the state has already passed. Do not combine `role` with `textContains`; a `textContains` wait that matches instantly has timed out when `role: "button"` was added. Neither predicate scrolls, and `exists` matches label values exactly.

### Android

Prefer semantic Android automation exposed by the current agent host. Otherwise inspect the current hierarchy with `adb shell uiautomator dump`, target stable resource IDs, content descriptions, text, or bounds, and use scoped `adb shell input` actions. Refresh the hierarchy after navigation. Capture the final state with `adb exec-out screencap -p`.

Android does not use serve-sim. Use a browser-compatible Android mirror when the host already provides one; otherwise return focused emulator screenshots as evidence rather than installing unrelated streaming infrastructure during verification.

## Verify and clean up

Exercise only the affected flow on one representative device unless the change specifically concerns platform, OS version, or screen size. Before finishing:

1. Confirm the app connected to the intended disposable environment rather than merely rendering an empty disconnected state. The client's own cache is the fastest proof on iOS:

   ```bash
   xcrun simctl get_app_container <simulator-udid> <resolved-bundle-id> data
   sqlite3 -readonly '<data-container>/Documents/SQLite/t3code-client.db' \
     "select payload from client_cache where kind = 'config'"
   ```

   The `config` payload carries `environmentId`, the environment label, the server version, and the backend's `cwd`; match them against the environment this test started. (`client_preferences` is a single JSON `payload` row, not a key/value table.)

2. Capture the relevant final state.
3. Remove the disposable environment from T3 Code Dev.
4. Remove any `adb reverse` rule created for this test with `adb -s <emulator-serial> reverse --remove tcp:<metro-port>`.
5. Stop only the serve-sim, Metro, backend, emulator, and log processes started by this test.
6. Remove only base directories and temporary Git repositories deliberately created for this test. Preserve them when they contain useful reproduction evidence.
7. Keep the generated `apps/mobile/ios` project and the worktree-local derived-data directory. Both are gitignored build caches, not test state; deleting them forces the next pass to pay a full prebuild plus a clean simulator build (about 3.5 minutes combined).

Keep local verification focused. Do not turn this workflow into a full repository test run.

## Troubleshoot predictable failures

- **Old UI or an old error appears:** verify Metro's worktree, variant, URL, and port before diagnosing the app.
- **A development URL opens the wrong build:** check for another installed app claiming `t3code-dev`; launch and verify the expected client by its resolved bundle identifier, and remove only conflicting test-owned installs.
- **An iOS build fails instantly with `spawn /usr/bin/xcrun ENOENT`:** the configured `.xcworkspace` does not exist (missing or wrong-variant generated project). Check the workspace path before diagnosing Xcode or the MCP server — this error has appeared with `xcrun` installed and healthy.
- **`simctl get_app_container` prints a path but launch says the app is missing:** the result can be stale immediately after `boot_sim`. Treat `install_app_sim` / `launch_app_sim` as the authority and re-check after the device settles.
- **`simctl openurl` fails with `LSApplicationWorkspaceErrorDomain … code=115`:** no installed app claims the scheme. Install and launch the client first; the error is not about the URL's contents.
- **`Cannot find native module` appears:** the installed client is native-incompatible even when its identifier is correct. The _generated project_ can be stale for the same reason the _client binary_ can — compare declared modules (`app.config.ts` + lockfile) against both before assuming one rebuild fixes it. Clean-prebuild the affected platform, then build separately.
- **The app installs but dies at launch:** packaging, not JS or signing. Read the crash report first; `Library not loaded: @rpath/<Framework>` means the bundle is missing an embedded framework (check `Frameworks/React.framework` and `Frameworks/ReactNativeDependencies.framework`). Fix the Expo build properties and do a full clean rebuild — reinstalling the same artifact cannot help.
- **The dev client holds on its splash after the bundle loads:** stop the app and reopen the same development-client URL. Check the XcodeBuildMCP runtime/OSLog files under `~/Library/Developer/XcodeBuildMCP/workspaces/<slug>/logs/` — a clean log means the launcher, not the bundle, is stuck.
- **A feature works in the browser but is missing on the device:** check surface identity before the environment. Web and mobile implement the same feature in separate components, and mobile can have more than one composer or entry screen. Identify the exact screen from `snapshot_ui` and grep `apps/mobile/src` for the feature's component; a browser pass already rules out backend and project-path causes, since server-side behavior is computed on the T3 server's filesystem for both clients.
- **A `wait_for_ui` text or label predicate times out:** usually a wrong assertion, not a broken app. Snapshot and screenshot to establish the actual screen, and prove seeded data through the client cache (see "Verify and clean up") rather than a text wait.
- **`no such module 'GhosttyKit'` on a simulator build:** the vendored `GhosttyKit.xcframework` ships arm64 slices only, and a `Release` simulator build requests `arm64 x86_64`. Build the simulator with `Debug` (the documented default) or pin `ARCHS=arm64`; do not switch to a scheme that excludes the terminal module — that stops verifying the app.
- **`Cannot find module 'xcode'` or `'expo/config-plugins'` from an inspection script:** pnpm does not hoist these; bare `require` fails from the repo root _and_ from `apps/mobile`. Resolve through a consumer — `require.resolve('expo/config-plugins', { paths: [path.resolve('apps/mobile')] })` or `createRequire` on a file in `apps/mobile/plugins/`. Never hardcode a `node_modules/.pnpm/<pkg>@<version>/` path.
- **`vp run lint:mobile` fails with `'swiftlint' exited with code 2`:** real `--strict` violations. If the offending file is under generated `apps/mobile/ios/`, fix the config plugin that emits it, not the file. Note a green `lint:mobile` is not proof the native linters ran — SwiftLint/ktlint/detekt are skipped silently when not installed.
- **The environment remains empty:** verify the platform-specific HTTP origin (including the `http://` prefix — see Pairing), use a fresh token, and confirm project seeding used the identical base directory.
- **A second client cannot pair:** pairing tokens are single-use; issue another token.
- **iOS semantic actions fail:** set explicit XcodeBuildMCP defaults, scroll the target away from viewport edges, refresh with `snapshot_ui`, and avoid batching layout-changing actions.
- **Android cannot reach Metro:** verify `adb reverse` for the exact Metro port and relaunch the development-client URL.
- **Android cannot reach the backend:** use `10.0.2.2`, not `127.0.0.1`, for the Android Emulator.
