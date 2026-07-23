"use strict";

// Applies the fork's missing widget-target integration:
// - ships the branded T3 mark to the Live Activity / widget extension;
// - marks the WidgetKit container background so gallery previews render;
// - aligns the extension's deployment and bundle versions with the app.
//
// expo-widgets generates ExpoWidgetsTarget without a Resources build phase and
// has no asset support. Its generated target also currently defaults to iOS
// 16.4 / version 1.0 and omits WidgetKit's required container-background marker.
// This plugin fixes those generated outputs after expo-widgets runs.
//
// ORDERING: must be listed BEFORE "expo-widgets" in the plugins array. Expo
// chains same-type mods so the last-registered runs FIRST; registering this
// plugin earlier makes its mods run AFTER expo-widgets' mods. That matters
// twice: expo-widgets' dangerous mod rmSync's ios/ExpoWidgetsTarget/ (deleting
// any catalog written before it), and its xcodeproj mod is what creates the
// widget target. Listed after expo-widgets, both steps silently no-op on a
// fresh prebuild — which is how prod build 8 shipped without the logo.

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
