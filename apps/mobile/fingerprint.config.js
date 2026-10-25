// @ts-check
const fs = require("node:fs");
const path = require("node:path");

// Include the major version, which Expo ignores, to prevent OTAs reaching older store binaries.
const appConfig = fs.readFileSync(path.join(__dirname, "app.config.ts"), "utf8");
// Same precedence as `appVersion` in app.config.ts (fork override, upstream release
// override, then the literal default).
const version =
  process.env.T3CODE_FORK_VERSION?.trim() ||
  process.env.T3CODE_MOBILE_VERSION?.trim() ||
  appConfig.match(/^ {2}repoEnv\.T3CODE_FORK_VERSION\?\.trim\(\) \|\| .* \|\| "([^"]+)";$/m)?.[1];
const majorVersion = version?.match(/^(\d+)\./)?.[1];
if (!majorVersion) {
  throw new Error("fingerprint.config.js could not read the app version from app.config.ts");
}

module.exports = {
  nativeModuleSourceType: "files",
  extraSources: [{ type: "contents", id: "appMajorVersion", contents: majorVersion }],
};
