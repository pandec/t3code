"use strict";

// expo prebuild leaves DEVELOPMENT_TEAM empty in the pbxproj, so xcodebuild can fall back to a
// personal-team identity that cannot sign app groups, Sign in with Apple, or push. Stamp the team
// on every build configuration. Register this plugin FIRST: Expo runs same-type mods in reverse
// order, so it then also stamps targets other plugins create (share extension, widgets).

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
