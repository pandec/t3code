import { assert, it } from "@effect/vitest";

import { renderExportOptionsPlist, resolveBuildNumber, resolveSettings } from "./ios-testflight.ts";

const completeEnv = {
  T3CODE_APPLE_TEAM_ID: "abc1234567",
  T3CODE_ASC_KEY_ID: "KEY123",
  T3CODE_ASC_ISSUER_ID: "issuer-uuid",
  T3CODE_ASC_KEY_PATH: "local/keys/AuthKey_KEY123.p8",
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
    keyId: "KEY123",
    issuerId: "issuer-uuid",
    keyPath: "local/keys/AuthKey_KEY123.p8",
  });
});

it("reports every missing credential at once", () => {
  const settings = resolveSettings({ T3CODE_APPLE_TEAM_ID: "ABC1234567" });
  assert.deepEqual(settings, {
    missing: ["T3CODE_ASC_KEY_ID", "T3CODE_ASC_ISSUER_ID", "T3CODE_ASC_KEY_PATH"],
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

it("exports for App Store Connect without letting Xcode rewrite the build number", () => {
  const plist = renderExportOptionsPlist("ABC1234567");
  assert.include(plist, "<string>app-store-connect</string>");
  assert.include(plist, "<string>ABC1234567</string>");
  assert.match(plist, /<key>manageAppVersionAndBuildNumber<\/key>\s*<false\/>/u);
});
