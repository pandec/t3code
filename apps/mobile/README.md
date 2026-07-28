# T3 Code Mobile

> [!WARNING]
> T3 Code Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Preview`
- `production`: store/release build as `T3 Code`

Run commands from `apps/mobile`.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

Start Metro for the dev client:

```bash
vp run dev:client
```

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

This private fork also has stable commands for Bartosz's paid Apple Developer team. Both use
`com.pandec.tools.t3code`, install directly on a connected iPhone, and replace each other:

```bash
# Development build with Metro
vp run ios:local

# Self-contained Release build
vp run ios:local:release
```

### TestFlight

The fork ships to its own phone through internal TestFlight, which removes the cable from the
loop — `vp run ios:testflight` archives, signs, and uploads, and the build appears in TestFlight a
few minutes later:

```bash
vp run ios:testflight
```

This needs `T3CODE_APPLE_TEAM_ID`, `T3CODE_IOS_BUNDLE_ID`, `T3CODE_ASC_KEY_ID`,
`T3CODE_ASC_ISSUER_ID`, and `T3CODE_ASC_KEY_PATH` in the repository root `.env.local`; see
[`../../.env.example`](../../.env.example). The App Store Connect `.p8` downloads only once, so keep
a backup outside the repository. Before touching build artifacts, the script authenticates the key
with App Store Connect. The first distribution can also create an Apple Distribution certificate
and App Store provisioning profiles through `-allowProvisioningUpdates`.

The script always builds the `production` variant, because TestFlight requires the production APNs
entitlement. `T3CODE_FORK_VERSION` supplies the marketing version shown in Settings, and the build
number is derived from the clock in one-minute steps — App Store Connect rejects a repeated build
number, so wait for the next minute before retrying a successful upload.

> [!NOTE]
> `updates.enabled` is false whenever a custom Apple team signs the build, so this route has no OTA
> updates: every change, JavaScript or native, needs a new TestFlight build. The "check for update"
> row in Settings stays inert.

Because the TestFlight build shares `com.pandec.tools.t3code` with the cable-installed app, the two
cannot coexist. Delete the side-loaded app before installing from TestFlight. The local SQLite cache
is discarded with it, while paired connections live in the iOS keychain and normally survive.

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

CI uses Expo fingerprinting with the `preview:dev` profile to reuse an existing compatible build when possible, or start a new internal EAS build when native runtime inputs change. Production and default local builds continue to use the `appVersion` runtime policy.

For preview or production EAS environments, set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`
as EAS environment variables. Expo config maps the canonical values into the mobile build.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
