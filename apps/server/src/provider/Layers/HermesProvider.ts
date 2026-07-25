import {
  type HermesSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeHermesAcpRuntime } from "../acp/HermesAcpSupport.ts";
import { readHermesSkillsSnapshot } from "../hermesSkillsSnapshot.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const HERMES_ACP_DISCOVERY_TIMEOUT_MS = 15_000;
const HERMES_COMMAND_DISCOVERY_GRACE_MS = 500;

const HERMES_DEFAULT_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Hermes default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialHermesProviderSnapshot(
  hermesSettings: HermesSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = hermesModelsFromSettings(hermesSettings.customModels);

    if (!hermesSettings.enabled) {
      return buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Hermes CLI availability...",
      },
    });
  });
}

function hermesModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = HERMES_DEFAULT_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildHermesDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>(["default"]);
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = model.modelId.trim();
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

interface HermesAcpDiscovery {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

function parseHermesAvailableCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return commands.flatMap((command) => {
    const name = command.name.trim();
    if (!name) {
      return [];
    }
    const description = command.description.trim();
    const hint = command.input?.hint?.trim();
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

const discoverHermesViaAcp = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeHermesAcpRuntime({
      hermesSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const slashCommandsBySessionRef = yield* Ref.make<
      ReadonlyMap<string, ReadonlyArray<ServerProviderSlashCommand>>
    >(new Map());
    yield* acp.handleSessionUpdate((notification) => {
      const update = notification.update;
      if (update.sessionUpdate !== "available_commands_update") {
        return Effect.void;
      }
      return Ref.update(slashCommandsBySessionRef, (current) => {
        const sessionId = String(notification.sessionId);
        if (current.has(sessionId)) {
          return current;
        }
        const next = new Map(current);
        next.set(sessionId, parseHermesAvailableCommands(update.availableCommands));
        return next;
      });
    });
    const started = yield* acp.start();
    const slashCommands = yield* Effect.gen(function* () {
      while (true) {
        const commands = (yield* Ref.get(slashCommandsBySessionRef)).get(started.sessionId);
        if (commands !== undefined) {
          return commands;
        }
        yield* Effect.sleep("10 millis");
      }
    }).pipe(
      Effect.timeoutOption(HERMES_COMMAND_DISCOVERY_GRACE_MS),
      Effect.map(Option.getOrElse((): ReadonlyArray<ServerProviderSlashCommand> => [])),
    );
    return {
      models: buildHermesDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models),
      slashCommands,
    } satisfies HermesAcpDiscovery;
  }).pipe(Effect.scoped);

const runHermesVersionCommand = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = hermesSettings.binaryPath || "hermes";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const runHermesGatewayStatusCommand = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = hermesSettings.binaryPath || "hermes";
    const spawnCommand = yield* resolveSpawnCommand(command, ["gateway", "status"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export function parseHermesVersionOutput(output: string): string | null {
  const firstLine = output.split(/\r?\n/u, 1)[0] ?? "";
  const match = firstLine.match(/(?:^|[^\d])(\d+\.\d+\.\d+)\b/u);
  return match?.[1] ?? null;
}

export function hermesGatewayStatusIsRunning(input: {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}): boolean {
  const output = `${input.stdout}\n${input.stderr}`;
  return (
    input.code === 0 &&
    !/\b(?:inactive|not\s+(?:active|running)|stopped)\b/iu.test(output) &&
    /\b(?:active|running)\b/iu.test(output)
  );
}

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = hermesModelsFromSettings(hermesSettings.customModels);

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runHermesVersionCommand(hermesSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Hermes CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Hermes CLI (`hermes`) is not installed or not on PATH."
          : "Failed to execute Hermes CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but timed out while running `hermes --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseHermesVersionOutput(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Hermes CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but failed to run.",
      },
    });
  }

  const skills = yield* readHermesSkillsSnapshot({ environment });
  if (hermesSettings.requireGateway) {
    const gatewayResult = yield* runHermesGatewayStatusCommand(hermesSettings, environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    const gatewayIsRunning =
      Result.isSuccess(gatewayResult) &&
      Option.isSome(gatewayResult.success) &&
      hermesGatewayStatusIsRunning(gatewayResult.success.value);
    if (!gatewayIsRunning) {
      return buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: hermesSettings.enabled,
        checkedAt,
        models: fallbackModels,
        skills,
        probe: {
          installed: true,
          version,
          status: "warning",
          auth: { status: "unknown" },
          message:
            "Hermes gateway is not running on this machine — enable Hermes only where it actually lives, or disable the gateway check in settings.",
        },
      });
    }
  }

  const discoveryExit = yield* discoverHermesViaAcp(hermesSettings, environment).pipe(
    Effect.timeoutOption(HERMES_ACP_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  let discovery: HermesAcpDiscovery | undefined;
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Hermes ACP discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
  } else if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Hermes ACP discovery timed out after ${HERMES_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
    );
  } else {
    discovery = discoveryExit.value.value;
  }
  const models =
    discovery && discovery.models.length > 0
      ? hermesModelsFromSettings(hermesSettings.customModels, [
          ...HERMES_DEFAULT_MODELS,
          ...discovery.models,
        ])
      : fallbackModels;

  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: hermesSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovery?.slashCommands ?? [],
    skills,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: discovery ? "authenticated" : "unknown" },
    },
  });
});

export const enrichHermesSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Hermes version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
