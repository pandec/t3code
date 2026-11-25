import type { ClaudeSettings, ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { readClaudeSettingsEnv } from "./ClaudeSkills.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath, home) : home);
});

/**
 * Single owner of Claude's config/session dir precedence: `homePath`, then the environment's
 * `CLAUDE_CONFIG_DIR` (a shadow dir from `makeClaudeEnvironment`), then `HOME/.claude`, with
 * relative inherited values resolved against `cwd`. Callers derive from it, never re-derive it.
 */
export const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
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
  return path.join(home, ".claude");
});

/**
 * The account-specific shadow config dir, or undefined on the shared dir. The CLI gets it as
 * `CLAUDE_CONFIG_DIR`, its own credential slot (macOS keychain entries and Linux
 * `.credentials.json` are keyed by config dir), while `materializeClaudeShadowHome` symlinks
 * session state back to the shared dir so continuation crosses accounts.
 */
export const resolveClaudeShadowConfigDirPath = Effect.fn("resolveClaudeShadowConfigDirPath")(
  function* (
    config: Pick<ClaudeSettings, "shadowHomePath">,
  ): Effect.fn.Return<string | undefined, never, Path.Path> {
    const path = yield* Path.Path;
    const shadowHomePath = config.shadowHomePath.trim();
    if (shadowHomePath.length === 0) return undefined;
    return path.resolve(expandHomePath(shadowHomePath, yield* HostProcess.HomeDirectory));
  },
);

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath" | "shadowHomePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  // Keep the instance environment independent of later process environment changes.
  const environment = { ...(baseEnv ?? process.env) };
  // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
  // Changing HOME hides macOS Keychain credentials; use CLAUDE_CONFIG_DIR to keep login access.
  const shadowConfigDirPath = yield* resolveClaudeShadowConfigDirPath(config);
  if (shadowConfigDirPath !== undefined) {
    // The shadow dir wins over homePath: the CLI must read this account's
    // credentials, while shared state reaches the homePath dir through the
    // materialized symlinks.
    environment.CLAUDE_CONFIG_DIR = shadowConfigDirPath;
    return environment;
  }
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    environment.CLAUDE_CONFIG_DIR = yield* resolveClaudeHomePath(config);
  }
  return environment;
});

/**
 * The environment for SDK history helpers (fork, transcript reads), with
 * `CLAUDE_CONFIG_DIR` pinned to the instance's resolved config directory. A
 * relative inherited value resolves against `cwd`, the directory the session
 * started in, so later worktree moves don't relocate its history.
 */
export const makeClaudeHistoryEnvironment = Effect.fn("makeClaudeHistoryEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  return {
    ...environment,
    CLAUDE_CONFIG_DIR: yield* resolveClaudeConfigDirPath(config, environment, cwd),
  };
});

// A Claude Code session that launched T3 exports these. A claude spawned with them acts as part of
// that session: its session id, messaging socket and token, and effort.
const CLAUDE_HOST_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
];

/**
 * Base env for the Claude processes T3 Code runs, before `makeClaudeEnvironment`.
 * Claude Code reads its entrypoint from the process env, not its settings `env`, so T3 Code applies that override itself.
 */
export const mergeClaudeProcessEnvironment = Effect.fn("mergeClaudeProcessEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...hostEnvironment,
    CLAUDE_CODE_ENTRYPOINT: "t3-code",
  };
  for (const name of CLAUDE_HOST_SESSION_VARIABLES) delete baseEnvironment[name];
  // The desktop runs the server as Node through Electron. Commands Claude runs inherit its env, so
  // an Electron app they start (T3 Code itself, VS Code) would run as Node and exit.
  delete baseEnvironment.ELECTRON_RUN_AS_NODE;
  const environment = yield* mergeProviderInstanceEnvironment(instanceEnvironment, baseEnvironment);
  const settingsEntrypoint = (yield* readClaudeSettingsEnv(config, undefined, environment))
    .CLAUDE_CODE_ENTRYPOINT;
  return settingsEntrypoint
    ? { ...environment, CLAUDE_CODE_ENTRYPOINT: settingsEntrypoint }
    : environment;
});

/** managed-mcp.json excludes other MCP config and forbids --strict-mcp-config; omit the flag when present. */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

// A worktree's .git file points at <main>/.git/worktrees/<name>, whose commondir leads back to
// <main>/.git. A bare repository has no main checkout, so its worktree keeps its own file.
// Untraced because claudeLocalSettingsDirectory already owns the span.
const mainCheckoutRoot = Effect.fnUntraced(function* (checkout: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(checkout, ".git")).pipe(
    Effect.flatMap((pointer) => {
      const gitDir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
      if (gitDir === undefined) return Effect.succeed(checkout);
      const worktreeGitDir = path.resolve(checkout, gitDir);
      return fileSystem.readFileString(path.join(worktreeGitDir, "commondir")).pipe(
        Effect.map((commonDir) => {
          const common = path.resolve(worktreeGitDir, commonDir.trim());
          return path.basename(common) === ".git" ? path.dirname(common) : checkout;
        }),
      );
    }),
    Effect.orElseSucceed(() => checkout),
  );
});

// Claude Code keeps .claude/settings.local.json at the repository root, or in cwd outside a
// repository, on Windows, or when the root is home. Its owner check is skipped, so callers must
// stay safe when Claude Code ignores the root file.
export const claudeLocalSettingsDirectory = Effect.fn("claudeLocalSettingsDirectory")(function* (
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if ((yield* HostProcess.Platform) === "win32") return cwd;
  for (let directory = cwd; ; directory = path.dirname(directory)) {
    const isCheckout = yield* fileSystem
      .exists(path.join(directory, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isCheckout) {
      const root = yield* mainCheckoutRoot(directory);
      return root === (yield* HostProcess.HomeDirectory) ? cwd : root;
    }
    if (path.dirname(directory) === directory) return cwd;
  }
});

// The continuation key deliberately ignores `shadowHomePath`: a shadow
// instance shares its session transcripts with the homePath dir (via the
// materialized `projects` symlink), so instances differing only by shadow dir
// belong to one continuation group and threads may move between them.
export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<string, never, Path.Path | FileSystem.FileSystem> {
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
    const fileSystem = yield* FileSystem.FileSystem;
    const configDirPath = yield* resolveClaudeConfigDirPath(config, environment);
    // Two instances that reach one Claude home through a symlink share sessions, so they can resume.
    // Only the key uses the real path: the spawn keeps the literal path, which names the Keychain login.
    const canonicalConfigDirPath = yield* fileSystem
      .realPath(configDirPath)
      .pipe(Effect.orElseSucceed(() => configDirPath));
    return `claude:home:${canonicalConfigDirPath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath" | "shadowHomePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const configDirPath = yield* resolveClaudeConfigDirPath(config, environment, cwd);
    // Unlike the continuation key, the capabilities key must separate shadow
    // instances: each shadow dir is its own credential slot, so auth-derived
    // probe results never transfer across accounts.
    const shadowConfigDirPath = yield* resolveClaudeShadowConfigDirPath(config);
    return `${config.binaryPath}\0${configDirPath}\0${shadowConfigDirPath ?? ""}\0${cwd ?? ""}`;
  },
);

/** Separate spawn env from login commands to preserve literal paths, including relative inherited values. */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
