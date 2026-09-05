import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ModelSelection,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type SlashCommand as ClaudeSlashCommand,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "../Drivers/ClaudeSkills.ts";
import { makeUnavailableUsageLimits } from "../providerUsageLimits.ts";
import {
  type ClaudeScopedLimitNames,
  claudeUsageResponseToLimits,
  recordClaudeUsageResponse,
} from "./claudeUsageLimits.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  CUSTOM_CLAUDE_MODEL_CAPABILITIES,
  type ClaudeModelCatalog,
  formatClaudeVersionUpgradeMessage,
  isClaudeCatalogUltracodeEffort,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindow,
  resolveClaudeCatalogModel,
  resolveClaudeModelsForVersion,
  scopeClaudeModelCatalog,
} from "../ClaudeModelCatalog.ts";

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
} as const;
export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  return (
    resolveClaudeCatalogModel(BUNDLED_CLAUDE_MODEL_CATALOG, model)?.model.capabilities ??
    CUSTOM_CLAUDE_MODEL_CAPABILITIES
  );
}

export function isBuiltInClaudeModel(model: string | null | undefined): boolean {
  return resolveClaudeCatalogModel(BUNDLED_CLAUDE_MODEL_CATALOG, model) !== undefined;
}

/** Compatibility helper for callers that do not yet have a scoped catalog. */
export function isCustomClaudeModel(model: string | null | undefined): boolean {
  const slug = model?.trim();
  return typeof slug === "string" && slug.length > 0 && !isBuiltInClaudeModel(slug);
}

export function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");
  const value = getProviderOptionCurrentValue(effortDescriptor);
  return typeof value === "string" ? value : undefined;
}

export function normalizeClaudeCliEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  return !effort || !isBuiltInClaudeModel(model)
    ? undefined
    : normalizeClaudeCatalogEffort(BUNDLED_CLAUDE_MODEL_CATALOG, effort, model);
}

export function isClaudeUltracodeEffort(effort: string | null | undefined): boolean {
  return isClaudeCatalogUltracodeEffort(effort);
}

export function resolveClaudeContextWindow(
  modelSelection: ModelSelection | undefined,
): string | undefined {
  return resolveClaudeCatalogContextWindow(BUNDLED_CLAUDE_MODEL_CATALOG, modelSelection);
}

export function resolveClaudeApiModelId(modelSelection: ModelSelection): string {
  const catalog = isCustomClaudeModel(modelSelection.model)
    ? scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, [modelSelection.model])
    : BUNDLED_CLAUDE_MODEL_CATALOG;
  return resolveClaudeCatalogApiModelId(catalog, modelSelection);
}

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

// ── SDK capability probe ────────────────────────────────────────────

// Amazon Bedrock initializes far slower than first-party auth: the SDK boots the
// Bedrock backend and runs the `awsAuthRefresh` credential hook before returning
// account info. The previous 8s budget expired mid-init, so the probe returned
// `undefined` and left the provider unverified and unselectable in the picker.
export const CLAUDE_SDK_INITIALIZATION_TIMEOUT_MS = 25_000;

/**
 * Keep workspace-scoped command discovery intact while isolating the periodic
 * health check from configured MCP servers.
 */
export const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/** Build the exact SDK options used by the periodic Claude capability probe. */
export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // The probe keeps filesystem setting sources for slash-command discovery,
    // but must not run the user's hooks: it fires every few minutes, so
    // SessionStart hooks would run on every health check.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Ignore MCP definitions from every filesystem setting source above. The
    // SDK combines this empty explicit map with --strict-mcp-config.
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...input.environment,
      // Connected claude.ai MCP servers are discovered outside filesystem
      // config; disable them independently for this health check.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // This is a noninteractive health check, so IDE discovery cannot add any
      // useful capability data. Skipping it also avoids Claude spawning a
      // Windows `tasklist | findstr` process tree on every periodic refresh.
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  /**
   * Active API backend reported by the SDK's `AccountInfo`. Anthropic OAuth
   * login only applies when `"firstParty"`; for Amazon Bedrock (`"bedrock"`)
   * the subscription/token fields are absent and auth is external AWS creds.
   */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  /**
   * Subscription windows from the SDK's `get_usage` control request, or
   * `undefined` when the request itself failed. Absent windows on an
   * otherwise successful response mean the account has none (API key).
   */
  readonly usage?: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

export function parseClaudeSkills(
  skills: ReadonlyArray<ClaudeSlashCommand>,
): ReadonlyArray<ServerProviderSkill> {
  const skillsByName = new Map<string, ServerProviderSkill>();

  for (const skill of skills) {
    const name = nonEmptyProbeString(skill.name);
    if (!name) continue;

    const key = name.toLowerCase();
    if (skillsByName.has(key)) continue;

    const description = nonEmptyProbeString(skill.description);
    skillsByName.set(key, {
      name,
      enabled: true,
      // `skills/reload` reports exactly the skills the model may invoke.
      modelInvocable: true,
      ...(description ? { description } : {}),
    });
  }

  return [...skillsByName.values()];
}

/**
 * Combine the SDK's skill list with a filesystem scan of the same workspace.
 *
 * `skills/reload` omits skills carrying `disable-model-invocation: true`, so
 * on its own it hides skills the user can still run by hand — precisely the
 * ones they reach for from the composer picker. The disk scan supplies those,
 * plus the `path`/`scope` metadata the SDK never reports. The SDK in turn
 * contributes plugin- and bundle-provided skills that live outside the two
 * directories the scan walks, so neither source is a superset of the other.
 *
 * The initialization command list is the authority on user invocation. It
 * removes model-only skills (`user-invocable: false`) and effective `off`
 * overrides even when `skills/reload` reports them to the model.
 *
 * Anything the scan found but the SDK did not is, by construction, invisible
 * to the model — that outranks whatever the frontmatter claimed.
 */
export function mergeClaudeSkills(
  nativeSkills: ReadonlyArray<ServerProviderSkill>,
  discoveredSkills: ReadonlyArray<ServerProviderSkill>,
  userInvocableSkillNames?: ReadonlySet<string>,
): ReadonlyArray<ServerProviderSkill> {
  const skillsByName = new Map<string, ServerProviderSkill>();

  for (const skill of gateClaudeSkillsByUserInvocation(discoveredSkills, userInvocableSkillNames)) {
    skillsByName.set(skill.name.toLowerCase(), { ...skill, modelInvocable: false });
  }

  for (const skill of gateClaudeSkillsByUserInvocation(nativeSkills, userInvocableSkillNames)) {
    const key = skill.name.toLowerCase();
    const discovered = skillsByName.get(key);
    skillsByName.set(key, {
      ...skill,
      ...(discovered?.path ? { path: discovered.path } : {}),
      ...(discovered?.scope ? { scope: discovered.scope } : {}),
      modelInvocable: true,
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Drop skills the CLI does not report as user-invocable.
 *
 * Used on its own when `skills/reload` failed but the initialization handshake
 * succeeded: the command list is still the authority on what `/name` resolves,
 * so serving the raw scan would surface skills disabled through
 * `skillOverrides` or conditional `paths:` skills that never activated.
 * Unlike the merged path this preserves each skill's frontmatter-derived
 * `modelInvocable`, because without the SDK list there is no evidence about
 * what the model can reach.
 *
 * An absent or empty name set carries no information and gates nothing.
 */
export function gateClaudeSkillsByUserInvocation(
  skills: ReadonlyArray<ServerProviderSkill>,
  userInvocableSkillNames: ReadonlySet<string> | undefined,
): ReadonlyArray<ServerProviderSkill> {
  if (userInvocableSkillNames === undefined || userInvocableSkillNames.size === 0) {
    return skills;
  }
  return skills.filter((skill) => userInvocableSkillNames.has(skill.name.toLowerCase()));
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    return yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the Anthropic API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: abort,
          environment: claudeEnvironment,
          cwd,
        }),
      });
      const init = await q.initializationResult();
      return { q, init };
    });
  }).pipe(
    Effect.timeout(CLAUDE_SDK_INITIALIZATION_TIMEOUT_MS),
    Effect.flatMap(({ q, init }) =>
      Effect.gen(function* () {
        // Usage has its own deadline so a slow optional request cannot discard initialization.
        const usageResult = yield* Effect.tryPromise(() =>
          q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
        ).pipe(Effect.timeout(DEFAULT_TIMEOUT_MS), Effect.result);
        const usage = Result.isSuccess(usageResult)
          ? {
              rate_limits_available: usageResult.success.rate_limits_available,
              rate_limits: usageResult.success.rate_limits,
            }
          : undefined;
        const account = init.account as
          | {
              readonly email?: string;
              readonly subscriptionType?: string;
              readonly tokenSource?: string;
              readonly apiProvider?: string;
            }
          | undefined;
        return {
          email: account?.email,
          subscriptionType: account?.subscriptionType,
          tokenSource: account?.tokenSource,
          apiProvider: account?.apiProvider,
          slashCommands: parseClaudeInitializationCommands(init.commands),
          ...(usage ? { usage } : {}),
        } satisfies ClaudeCapabilitiesProbe;
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.result,
    Effect.map((result) => (Result.isSuccess(result) ? result.success : undefined)),
  );
};

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  /** Shared with the adapter so turn events reuse the scoped-bucket names this probe saw. */
  scopedLimitNames?: Ref.Ref<ClaudeScopedLimitNames>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = providerModelsFromSettings(
    modelCatalog.models.map((entry) => entry.model),
    claudeSettings.customModels,
    CUSTOM_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) was not found on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const models = providerModelsFromSettings(
    resolveClaudeModelsForVersion(modelCatalog, parsedVersion),
    claudeSettings.customModels,
    CUSTOM_CLAUDE_MODEL_CAPABILITIES,
  );
  const versionUpgradeMessage = formatClaudeVersionUpgradeMessage(modelCatalog, parsedVersion);

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment);
  const slashCommands = [COMPACT_SLASH_COMMAND, ...(capabilities?.slashCommands ?? [])];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  const authMetadata =
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
    }) ?? apiProviderAuthMetadata(capabilities.apiProvider);
  const usageLimits = !capabilities.usage
    ? makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" })
    : scopedLimitNames
      ? yield* recordClaudeUsageResponse(scopedLimitNames, {
          response: capabilities.usage,
          checkedAt,
        })
      : claudeUsageResponseToLimits({ response: capabilities.usage, checkedAt }).limits;
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    slashCommands: dedupedSlashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(versionUpgradeMessage ? { message: versionUpgradeMessage } : {}),
      usageLimits,
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      modelCatalog.models.map((entry) => entry.model),
      claudeSettings.customModels,
      CUSTOM_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

export { probeClaudeCapabilities };
