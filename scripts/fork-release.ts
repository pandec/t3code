#!/usr/bin/env node
/**
 * Private fork: build this host's t3 server archive from the checkout into a local release folder
 * and switch the background service to it. Versions are `<version>-pandec.<YYYYMMDD>.<n>`.
 */
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
  cliArchivePlatformKey,
  type CliArchivePlatformKey,
  FORK_RELEASE_PRERELEASE_ID,
} from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { releasePackageFiles } from "./update-release-package-versions.ts";

const KEEP_RELEASES = 3;
const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const releaseRoot = NodePath.join(
  process.env["T3CODE_HOME"] || NodePath.join(NodeOS.homedir(), ".t3"),
  "fork-releases",
);
const releaseDirPattern = new RegExp(
  `^v\\d+\\.\\d+\\.\\d+-${FORK_RELEASE_PRERELEASE_ID}\\.\\d{8}\\.(\\d+)$`,
);

// Default handlers kill Node and skip the manifest restore; forward to the step and fail it instead.
let interrupted: NodeJS.Signals | undefined;
let activeChild: NodeChildProcess.ChildProcess | undefined;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    interrupted = signal;
    activeChild?.kill(signal);
  });
}

async function run(command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) {
  if (interrupted !== undefined) throw new Error(`Interrupted by ${interrupted}.`);
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const child = NodeChildProcess.spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  activeChild = child;
  try {
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      },
    );
    if (code !== 0 || interrupted !== undefined) {
      throw new Error(
        `${command} ${args.join(" ")} failed (${interrupted ?? signal ?? `exit ${String(code)}`}).`,
      );
    }
  } finally {
    activeChild = undefined;
  }
}

interface HostTarget {
  readonly platform: "linux" | "mac";
  readonly arch: "x64" | "arm64";
  readonly platformKey: CliArchivePlatformKey;
}

function hostTarget(hostPlatform: NodeJS.Platform, hostArch: string): HostTarget {
  const platform =
    hostPlatform === "linux" ? "linux" : hostPlatform === "darwin" ? "mac" : undefined;
  const arch = hostArch === "x64" || hostArch === "arm64" ? hostArch : undefined;
  const platformKey = cliArchivePlatformKey(hostPlatform, hostArch);
  if (platform === undefined || arch === undefined || platformKey === undefined) {
    throw new Error(`No t3 archive for ${hostPlatform}-${hostArch}.`);
  }
  return { platform, arch, platformKey };
}

function nextVersion(): string {
  const { version } = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, "apps/server/package.json"), "utf8"),
  ) as { version: string };
  const base = version.split("-")[0];
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const used = NodeFS.existsSync(releaseRoot)
    ? NodeFS.readdirSync(releaseRoot)
        .filter((name) => name.includes(`-${FORK_RELEASE_PRERELEASE_ID}.${date}.`))
        .map((name) => Number(releaseDirPattern.exec(name)?.[1] ?? 0))
    : [];
  return `${base}-${FORK_RELEASE_PRERELEASE_ID}.${date}.${String(Math.max(0, ...used) + 1)}`;
}

async function buildArchive(target: HostTarget, version: string, releaseDir: string) {
  const { platform, arch } = target;
  const resourceMonitorDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-monitor-"));
  // Archive versions come from these manifests; restore them so the checkout stays clean.
  const manifests = releasePackageFiles.map((file) => {
    const filePath = NodePath.join(repoRoot, file);
    return [filePath, NodeFS.readFileSync(filePath)] as const;
  });
  try {
    await run("node", ["scripts/update-release-package-versions.ts", version]);
    await run("vp", ["run", "--filter", "t3", "build"]);
    await run("vp", ["run", "build:resource-monitor"]);
    NodeFS.copyFileSync(
      NodePath.join(repoRoot, "native/resource-monitor/target/release/t3-resource-monitor"),
      NodePath.join(resourceMonitorDir, "t3-resource-monitor"),
    );
    await run("node", ["apps/server/scripts/cli.ts", "build-exe"]);
    await run("node", [
      "scripts/build-cli-archive.ts",
      "--platform",
      platform,
      "--arch",
      arch,
      "--version",
      version,
      "--output-dir",
      releaseDir,
      "--resource-monitor-dir",
      resourceMonitorDir,
    ]);
  } finally {
    for (const [filePath, contents] of manifests) NodeFS.writeFileSync(filePath, contents);
    NodeFS.rmSync(resourceMonitorDir, { recursive: true, force: true });
  }
  const fileName = cliArchiveFileName(version, target.platformKey);
  const archivePath = NodePath.join(releaseDir, fileName);
  await run("node", [
    "scripts/smoke-cli-archive.ts",
    "--archive",
    archivePath,
    "--expect-version",
    version,
  ]);
  const digest = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(archivePath))
    .digest("hex");
  NodeFS.writeFileSync(
    NodePath.join(releaseDir, CLI_RELEASE_CHECKSUMS_FILE),
    `${digest}  ${fileName}\n`,
  );
}

function pruneReleases() {
  const releases = NodeFS.readdirSync(releaseRoot)
    .filter((name) => releaseDirPattern.test(name))
    .map((name) => ({ name, mtime: NodeFS.statSync(NodePath.join(releaseRoot, name)).mtimeMs }))
    .toSorted((a, b) => b.mtime - a.mtime);
  for (const { name } of releases.slice(KEEP_RELEASES)) {
    NodeFS.rmSync(NodePath.join(releaseRoot, name), { recursive: true, force: true });
  }
}

const target = hostTarget(
  ...(await Effect.runPromise(Effect.all([HostProcess.Platform, HostProcess.Architecture]))),
);
// build-cli-archive needs it only at the end, after the long build.
if (target.platform === "linux" && NodeChildProcess.spawnSync("patchelf", ["--version"]).error) {
  throw new Error("patchelf is missing; install it with `sudo apt install patchelf`.");
}
const version = nextVersion();
const releaseDir = NodePath.join(releaseRoot, `v${version}`);
console.log(`Building t3@${version} into ${releaseDir}`);
try {
  await buildArchive(target, version, releaseDir);
} catch (error) {
  NodeFS.rmSync(releaseDir, { recursive: true, force: true });
  throw error;
}
// The new executable is already on this version, so `update` only moves the background service.
// --allow-downgrade covers the first switch, since `x.y.z-pandec.*` sorts below upstream `x.y.z`.
await run("apps/server/dist-exe/t3", ["update", version, "--yes", "--allow-downgrade"], {
  [CLI_RELEASE_BASE_URL_ENV]: NodeURL.pathToFileURL(releaseRoot).href,
});
pruneReleases();
