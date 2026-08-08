import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as CliError from "effect/unstable/cli/CliError";
import * as CliOutput from "effect/unstable/cli/CliOutput";

import {
  CliOrchestrationOutcomeUnknownError,
  CliOrchestrationWaitOutcomeUnknownError,
} from "./orchestration.ts";

const isCliOrchestrationOutcomeUnknownError = Schema.is(CliOrchestrationOutcomeUnknownError);
const isCliOrchestrationWaitOutcomeUnknownError = Schema.is(
  CliOrchestrationWaitOutcomeUnknownError,
);

export interface CliJsonError {
  readonly code: string;
  readonly message: string;
  readonly outcome?: "unknown";
  readonly detail?: Record<string, string | number | boolean | null>;
}

const isJsonPrimitive = (value: unknown): value is string | number | boolean | null =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

export const serializeCliError = (error: unknown): CliJsonError => {
  if (CliError.isCliError(error) && error._tag === "ShowHelp" && error.errors.length > 0) {
    return serializeCliError(error.errors[0]);
  }
  if (Predicate.isObject(error) && typeof error["_tag"] === "string") {
    const detail: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(error)) {
      if (key === "_tag" || key === "cause" || key.startsWith("~")) continue;
      if (isJsonPrimitive(value)) {
        detail[key] = value;
      }
    }
    const message = error["message"];
    return {
      code: error["_tag"],
      message: typeof message === "string" ? message : String(error),
      // A lost acknowledgement or unconfirmed multi-step compensation leaves
      // the mutation outcome ambiguous.
      ...(isCliOrchestrationOutcomeUnknownError(error) ||
      isCliOrchestrationWaitOutcomeUnknownError(error)
        ? { outcome: "unknown" as const }
        : {}),
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    };
  }
  if (error instanceof Error) {
    return { code: error.name.length > 0 ? error.name : "Error", message: error.message };
  }
  return { code: "UnknownError", message: String(error) };
};

/**
 * In `--json` mode, failures are reported as one structured JSON document on
 * stdout and a non-zero exit code, instead of the runtime's pretty-printed
 * cause. The effect is converted to a success so the process can drain stdout
 * naturally; the exit code is set explicitly.
 */
export const withCliJsonErrorOutput =
  (json: boolean) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | void, E, R> =>
    json
      ? Effect.catch(effect, (error) =>
          Effect.gen(function* () {
            yield* Console.log(
              // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON is a presentation DTO.
              JSON.stringify({ error: serializeCliError(error) }, null, 2),
            );
            yield* Effect.sync(() => {
              process.exitCode = 1;
            });
          }),
        )
      : effect;

const cliActionFlags = new Set(["--help", "-h", "--version", "-v", "--completions"]);

export const isCliJsonOutputRequested = (args: ReadonlyArray<string>): boolean => {
  const separatorIndex = args.indexOf("--");
  const commandArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  return commandArgs.includes("--json") && !commandArgs.some((arg) => cliActionFlags.has(arg));
};

const silentUsageFormatter: CliOutput.Formatter = {
  ...CliOutput.defaultFormatter(),
  formatHelpDoc: () => "",
  formatErrors: () => "",
};

/**
 * Effect CLI renders parser failures before command handlers run. This
 * entry-point boundary suppresses that human usage rendering in `--json` mode,
 * then emits the same structured envelope used by handler failures.
 */
export const withCliJsonUsageErrorOutput =
  (json: boolean) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | void, E, R> =>
    json
      ? Console.consoleWith((parentConsole) => {
          const quietConsole = Object.assign(Object.create(parentConsole) as Console.Console, {
            log: (...args: ReadonlyArray<unknown>) => {
              if (args.length !== 1 || args[0] !== "") parentConsole.log(...args);
            },
            error: (...args: ReadonlyArray<unknown>) => {
              if (args.length !== 1 || args[0] !== "") parentConsole.error(...args);
            },
          });
          const emitEnvelope = (error: unknown) =>
            Effect.sync(() => {
              parentConsole.log(
                // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON is a presentation DTO.
                JSON.stringify({ error: serializeCliError(error) }, null, 2),
              );
              process.exitCode = 1;
            });
          return effect.pipe(
            Effect.provideService(CliOutput.Formatter, silentUsageFormatter),
            Effect.provideService(Console.Console, quietConsole),
            Effect.catch(emitEnvelope),
            // Defects would otherwise bypass the JSON contract and render the
            // runtime's pretty cause report; interruption stays untouched.
            Effect.catchDefect(emitEnvelope),
          );
        })
      : effect;
