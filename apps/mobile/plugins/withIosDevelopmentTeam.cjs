"use strict";

// expo prebuild records ios.appleTeamId in workspace metadata but leaves
// DEVELOPMENT_TEAM empty in the generated pbxproj, so non-interactive
// `xcodebuild` — and `expo run:ios` on a machine whose Xcode has no session
// for the team — falls back to whichever signing identity it finds first,
// which on a personal team cannot sign app groups, Sign in with Apple, or
// push entitlements. Stamp the configured team on every build configuration
// so signing resolves deterministically on any machine that has the certs.
//
// ORDERING: register this plugin FIRST. Expo runs same-type mods in reverse
// registration order, so it executes after every other plugin has created its
// native targets (share extension, widgets) and stamps those too.

const { withXcodeProject } = require("expo/config-plugins");

module.exports = function withIosDevelopmentTeam(config) {
  const appleTeamId = config.ios?.appleTeamId;
  if (!appleTeamId) return config;
  return withXcodeProject(config, (cfg) => {
    const buildConfigurations = cfg.modResults.hash.project.objects.XCBuildConfiguration ?? {};
    for (const [key, buildConfiguration] of Object.entries(buildConfigurations)) {
      if (!key.endsWith("_comment") && buildConfiguration?.buildSettings) {
        buildConfiguration.buildSettings.DEVELOPMENT_TEAM = appleTeamId;
      }
    }
    return cfg;
  });
};
