import { type HermesSettings, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { decodeHermesSetModeResult, hermesModeIdForRuntimeMode } from "./HermesAcpExtension.ts";

type HermesAcpRuntimeSettings = Pick<HermesSettings, "authMethodId" | "binaryPath">;

interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "promptConcurrency" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    env: {
      ...environment,
    },
  };
}

export function resolveHermesAcpAuthMethodId(
  hermesSettings: Pick<HermesSettings, "authMethodId"> | null | undefined,
  initializeResult: EffectAcpSchema.InitializeResponse,
): string | undefined {
  return hermesSettings?.authMethodId?.trim() || initializeResult.authMethods?.[0]?.id;
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { childProcessSpawner, environment, hermesSettings, ...runtimeOptions } = input;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: buildHermesAcpSpawnInput(hermesSettings, input.cwd, environment),
        authMethodId: (initializeResult) =>
          resolveHermesAcpAuthMethodId(hermesSettings, initializeResult),
        promptConcurrency: "concurrent",
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveHermesAcpModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  return !trimmed || trimmed === "default" ? undefined : trimmed;
}

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function currentHermesModeIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.modes?.currentModeId?.trim() || undefined;
}

export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requestedModelId = resolveHermesAcpModelId(input.requestedModelId);
  if (requestedModelId === undefined || requestedModelId === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModelId));
}

export function applyHermesAcpModeSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">;
  readonly sessionId: string;
  readonly currentModeId: string | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<"default" | "dont_ask", E> {
  const modeId = hermesModeIdForRuntimeMode(input.runtimeMode);
  if (input.currentModeId === modeId) {
    return Effect.succeed(modeId);
  }
  return input.runtime
    .request("session/set_mode", { sessionId: input.sessionId, modeId })
    .pipe(
      Effect.flatMap(decodeHermesSetModeResult),
      Effect.mapError(input.mapError),
      Effect.as(modeId),
    );
}
