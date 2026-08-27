import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

/** Resolve the directory Claude uses for config and persisted project sessions. */
export const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  const environmentHome = environment.HOME?.trim() ?? "";
  if (environmentHome.length > 0) {
    const resolvedHome = cwd ? path.resolve(cwd, environmentHome) : path.resolve(environmentHome);
    return path.join(resolvedHome, ".claude");
  }
  return path.join(NodeOS.homedir(), ".claude");
});

/**
 * Resolve the account-specific shadow config dir, or undefined when the
 * instance runs directly on its shared config dir. When set, the spawned CLI
 * receives the shadow dir as `CLAUDE_CONFIG_DIR` — giving it its own
 * credential slot (macOS keychain entries and Linux `.credentials.json` are
 * both keyed by the config dir) — while `materializeClaudeShadowHome`
 * symlinks session state back to the shared dir so continuation crosses
 * accounts.
 */
export const resolveClaudeShadowConfigDirPath = Effect.fn("resolveClaudeShadowConfigDirPath")(
  function* (
    config: Pick<ClaudeSettings, "shadowHomePath">,
  ): Effect.fn.Return<string | undefined, never, Path.Path> {
    const path = yield* Path.Path;
    const shadowHomePath = config.shadowHomePath.trim();
    if (shadowHomePath.length === 0) return undefined;
    return path.resolve(expandHomePath(shadowHomePath));
  },
);

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath" | "shadowHomePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
  // Overriding HOME also relocates the macOS login keychain lookup
  // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
  // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
  // Claude Code at its config dir directly while leaving HOME (and the
  // keychain) intact.
  const shadowConfigDirPath = yield* resolveClaudeShadowConfigDirPath(config);
  if (shadowConfigDirPath !== undefined) {
    // The shadow dir wins over homePath: the CLI must read this account's
    // credentials, while shared state reaches the homePath dir through the
    // materialized symlinks.
    return {
      ...resolvedBaseEnv,
      CLAUDE_CONFIG_DIR: shadowConfigDirPath,
    };
  }
  const homePath = config.homePath.trim();
  // Copy instead of returning the base env by reference: when the base is
  // `process.env`, a by-reference environment would observe the fork driver's
  // temporary CLAUDE_CONFIG_DIR override (see ClaudeSessionFork.ts) at
  // whatever moment a session start happens to snapshot it.
  if (homePath.length === 0) return { ...resolvedBaseEnv };
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

// The continuation key deliberately ignores `shadowHomePath`: a shadow
// instance shares its session transcripts with the homePath dir (via the
// materialized `projects` symlink), so instances differing only by shadow dir
// belong to one continuation group and threads may move between them.
export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<string, never, Path.Path> {
    const homePath = config.homePath.trim();
    const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
    if (homePath.length === 0 && environmentConfigDir.length > 0) {
      const path = yield* Path.Path;
      if (!path.isAbsolute(environmentConfigDir)) {
        return `claude:relative-config:${environmentConfigDir}`;
      }
    }
    const environmentHome = environment.HOME?.trim() ?? "";
    if (homePath.length === 0 && environmentConfigDir.length === 0 && environmentHome.length > 0) {
      const path = yield* Path.Path;
      if (!path.isAbsolute(environmentHome)) {
        return `claude:relative-home:${environmentHome}`;
      }
    }
    const configDirPath = yield* resolveClaudeConfigDirPath(config, environment);
    return `claude:home:${configDirPath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath" | "shadowHomePath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    // Unlike the continuation key, the capabilities key must separate shadow
    // instances: each shadow dir is its own credential slot, so auth-derived
    // probe results never transfer across accounts.
    const shadowConfigDirPath = yield* resolveClaudeShadowConfigDirPath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${shadowConfigDirPath ?? ""}\0${cwd ?? ""}`;
  },
);
