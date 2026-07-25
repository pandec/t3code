import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { CliOrchestrationOutcomeUnknownError } from "./orchestration.ts";

const isCliOrchestrationOutcomeUnknownError = Schema.is(CliOrchestrationOutcomeUnknownError);

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
  if (Predicate.isObject(error) && typeof error["_tag"] === "string") {
    const detail: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(error)) {
      if (key === "_tag" || key === "cause") continue;
      if (isJsonPrimitive(value)) {
        detail[key] = value;
      }
    }
    const message = error["message"];
    return {
      code: error["_tag"],
      message: typeof message === "string" ? message : String(error),
      // Only an acknowledgement loss leaves the mutation outcome ambiguous;
      // every other failure means the command was not applied by this run.
      ...(isCliOrchestrationOutcomeUnknownError(error) ? { outcome: "unknown" as const } : {}),
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
