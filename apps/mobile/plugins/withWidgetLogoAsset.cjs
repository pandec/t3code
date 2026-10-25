"use strict";

// Fork widget-target integration: ships the T3 mark, marks the WidgetKit container background, and
// aligns the extension's deployment/bundle versions with the app (expo-widgets defaults 16.4/1.0).
// ORDERING: list BEFORE "expo-widgets" so its reverse-ordered mods create and wipe the target first;
// listed after it, both steps silently no-op on a fresh prebuild (prod build 8 shipped without the logo).

const path = require("path");
const fs = require("fs");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");
const { addWidgetAssetCatalog, configureWidgetTarget } = require("./lib/addWidgetAssetCatalog.cjs");

const TARGET_NAME = "ExpoWidgetsTarget";
const CATALOG_NAME = "Assets.xcassets";
const IMAGE_SET = "T3Mark.imageset";
const SVG_NAME = "T3Mark.svg";
const ENTRY_VIEW_PATTERN = /^(\s*)([A-Za-z0-9_]*WidgetsEntryView)\(entry: entry\)$/m;
const CONTAINER_BACKGROUND = ".containerBackground(for: .widget) { Color.clear }";

const CATALOG_CONTENTS = JSON.stringify({ info: { author: "expo", version: 1 } }, null, 2) + "\n";
const IMAGE_SET_CONTENTS =
  JSON.stringify(
    {
      images: [{ idiom: "universal", filename: SVG_NAME }],
      info: { author: "expo", version: 1 },
      properties: {
        "preserves-vector-representation": true,
        "template-rendering-intent": "template",
      },
    },
    null,
    2,
  ) + "\n";

function addContainerBackground(targetDir) {
  const swiftFiles = fs
    .readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".swift"))
    .map((entry) => path.join(targetDir, entry.name));

  let matched = false;
  for (const file of swiftFiles) {
    const source = fs.readFileSync(file, "utf8");
    if (source.includes(CONTAINER_BACKGROUND)) {
      matched = true;
      continue;
    }

    const updated = source.replace(ENTRY_VIEW_PATTERN, (_match, indent, entryView) => {
      matched = true;
      return `${indent}${entryView}(entry: entry)\n${indent}  ${CONTAINER_BACKGROUND}`;
    });
    if (updated !== source) fs.writeFileSync(file, updated);
  }

  if (!matched) {
    throw new Error(
      `withWidgetLogoAsset: no generated widget entry view found under ${targetDir}; ` +
        "expo-widgets output may have changed.",
    );
  }
}

function withGeneratedFiles(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const source = path.join(cfg.modRequest.projectRoot, "assets", "widget", SVG_NAME);
      const targetDir = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME);
      const catalogDir = path.join(targetDir, CATALOG_NAME);
      const imageSetDir = path.join(catalogDir, IMAGE_SET);
      fs.mkdirSync(imageSetDir, { recursive: true });
      fs.writeFileSync(path.join(catalogDir, "Contents.json"), CATALOG_CONTENTS);
      fs.writeFileSync(path.join(imageSetDir, "Contents.json"), IMAGE_SET_CONTENTS);
      fs.copyFileSync(source, path.join(imageSetDir, SVG_NAME));
      addContainerBackground(targetDir);
      return cfg;
    },
  ]);
}

function withTargetWiring(config, props) {
  return withXcodeProject(config, (cfg) => {
    addWidgetAssetCatalog(cfg.modResults, { targetName: TARGET_NAME });
    configureWidgetTarget(cfg.modResults, {
      targetName: TARGET_NAME,
      deploymentTarget: props.deploymentTarget,
      marketingVersion: cfg.version ?? "1.0",
      currentProjectVersion: cfg.ios?.buildNumber ?? "1",
    });
    return cfg;
  });
}

module.exports = function withWidgetLogoAsset(config, props = {}) {
  if (!props.deploymentTarget) {
    throw new Error("withWidgetLogoAsset requires a deploymentTarget option.");
  }
  return withTargetWiring(withGeneratedFiles(config), props);
};
