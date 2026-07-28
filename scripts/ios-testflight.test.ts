import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { isAppVersion } from "./lib/apple-mobile-config.ts";
import {
  isSameOrDescendantPath,
  renderExportOptionsPlist,
  resolveArtifactCleanupTargets,
  resolveBuildNumber,
  resolveSettings,
} from "./ios-testflight.ts";

const completeEnv = {
  T3CODE_APPLE_TEAM_ID: "abc1234567",
  T3CODE_IOS_BUNDLE_ID: "com.example.t3code",
  T3CODE_ASC_KEY_ID: "ABCDE12345",
  T3CODE_ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
  T3CODE_ASC_KEY_PATH: "local/keys/AuthKey_ABCDE12345.p8",
};

it("derives a build number that increases with wall-clock time", () => {
  const earlier = resolveBuildNumber(Date.UTC(2026, 6, 28, 5, 0));
  const later = resolveBuildNumber(Date.UTC(2026, 6, 28, 5, 1));
  assert.equal(Number(later) - Number(earlier), 1);
  // App Store Connect rejects a CFBundleVersion component that overflows a
  // 32-bit integer, so the epoch must leave decades of headroom.
  assert.isBelow(Number(resolveBuildNumber(Date.UTC(2126, 0, 1))), 2_147_483_647);
});

it("normalises the team id and keeps the remaining credentials verbatim", () => {
  const settings = resolveSettings(completeEnv);
  assert.deepEqual(settings, {
    teamId: "ABC1234567",
    bundleId: "com.example.t3code",
    keyId: "ABCDE12345",
    issuerId: "00000000-0000-0000-0000-000000000000",
    keyPath: "local/keys/AuthKey_ABCDE12345.p8",
  });
});

it("reports every missing credential at once", () => {
  const settings = resolveSettings({ T3CODE_APPLE_TEAM_ID: "ABC1234567" });
  assert.deepEqual(settings, {
    missing: [
      "T3CODE_IOS_BUNDLE_ID",
      "T3CODE_ASC_KEY_ID",
      "T3CODE_ASC_ISSUER_ID",
      "T3CODE_ASC_KEY_PATH",
    ],
  });
});

it("treats a blank credential as missing", () => {
  const settings = resolveSettings({ ...completeEnv, T3CODE_ASC_KEY_ID: "   " });
  assert.deepEqual(settings, { missing: ["T3CODE_ASC_KEY_ID"] });
});

it("refuses a Personal Team, which cannot sign App Store builds", () => {
  const settings = resolveSettings({ ...completeEnv, T3CODE_IOS_PERSONAL_TEAM: "1" });
  assert.isTrue("missing" in settings && settings.missing.length === 1);
});

it("rejects malformed App Store Connect credentials before starting a build", () => {
  const settings = resolveSettings({
    ...completeEnv,
    T3CODE_ASC_KEY_ID: "short",
    T3CODE_ASC_ISSUER_ID: "not-a-uuid",
  });
  assert.deepEqual(settings, {
    missing: [
      "T3CODE_ASC_KEY_ID must be a 10-character App Store Connect key ID",
      "T3CODE_ASC_ISSUER_ID must be a UUID",
    ],
  });
});

it("rejects a malformed team id and bundle identifier", () => {
  const settings = resolveSettings({
    ...completeEnv,
    T3CODE_APPLE_TEAM_ID: "TOOLONG12345",
    T3CODE_IOS_BUNDLE_ID: "nodots",
  });
  assert.deepEqual(settings, {
    missing: [
      "T3CODE_APPLE_TEAM_ID must be a 10-character Apple Team ID",
      "T3CODE_IOS_BUNDLE_ID must be a reverse-DNS bundle identifier",
    ],
  });
});

it.layer(NodeServices.layer)("artifact path safety", (it) => {
  it.effect("recognises destructive overlap without rejecting a safe sibling", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const artifactDir = path.join(path.sep, "repo", "local", "ios-testflight");
      assert.isTrue(
        isSameOrDescendantPath(
          path,
          path.join(artifactDir, "export"),
          path.join(artifactDir, "export", "AuthKey_ABCDE12345.p8"),
        ),
      );
      assert.isFalse(
        isSameOrDescendantPath(
          path,
          path.join(artifactDir, "export"),
          path.join(artifactDir, "keys", "AuthKey_ABCDE12345.p8"),
        ),
      );
      // The guard decides whether a recursive delete would swallow the key, so an
      // ancestor or an unrelated absolute path must never read as "contained".
      assert.isFalse(
        isSameOrDescendantPath(path, path.join(artifactDir, "export"), path.join(path.sep, "repo")),
      );
      assert.isFalse(
        isSameOrDescendantPath(
          path,
          path.join(artifactDir, "export"),
          path.join(path.sep, "elsewhere", "AuthKey_ABCDE12345.p8"),
        ),
      );
      // A prefix match on the path string is not containment.
      assert.isFalse(
        isSameOrDescendantPath(path, path.join(artifactDir, "export"), `${artifactDir}-export`),
      );
      assert.isTrue(isSameOrDescendantPath(path, artifactDir, artifactDir));
      assert.deepEqual(resolveArtifactCleanupTargets(path, artifactDir), [
        { path: path.join(artifactDir, "T3Code.xcarchive"), recursive: true },
        { path: path.join(artifactDir, "export"), recursive: true },
        { path: path.join(artifactDir, "ExportOptions.plist"), recursive: false },
      ]);
    }),
  );
});

it("requires three marketing-version components", () => {
  assert.isTrue(isAppVersion("3.0.29"));
  assert.isFalse(isAppVersion("3"));
  assert.isFalse(isAppVersion("3.0"));
  assert.isFalse(isAppVersion(""));
});

it("exports for App Store Connect without letting Xcode rewrite the build number", () => {
  const plist = renderExportOptionsPlist("ABC1234567");
  assert.include(plist, "<string>app-store-connect</string>");
  assert.include(plist, "<string>ABC1234567</string>");
  assert.match(plist, /<key>manageAppVersionAndBuildNumber<\/key>\s*<false\/>/u);
});
