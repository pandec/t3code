/**
 * Fork: runs the `sp-labs` CLI, T3's only channel to SP Labs (see the sp-labs
 * repo's `docs/t3.md`). Every command prints one JSON value; a failure exits 1
 * with `{ "error": string }`.
 */
import { LabsError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

/**
 * Identity the CLI reads from its environment. The server's own values (set when it runs inside
 * an agent shell) must never decide ownership, so they are always removed; acquire sets
 * `T3CODE_THREAD_ID` explicitly and lab mutations pass `--lease`.
 */
const INHERITED_IDENTITY_ENV = [
  "T3CODE_THREAD_ID",
  "T3CODE_TURN_ID",
  "CODEX_SESSION_ID",
  "SP_LABS_LEASE_ID",
  "SP_LABS_OPERATION_ID",
  "SP_LABS_RUNTIME_LAB_ID",
] as const;

export interface LabsCliRunInput {
  /** The sp-labs checkout; the CLI runs with it as cwd. */
  readonly directory: string;
  readonly args: ReadonlyArray<string>;
  /** Recorded as the reservation's owner (`acquire`). */
  readonly threadId?: ThreadId | undefined;
  readonly timeout: Duration.Input;
}

export class LabsCli extends Context.Service<
  LabsCli,
  {
    /** The command's parsed JSON output. */
    readonly run: (input: LabsCliRunInput) => Effect.Effect<unknown, LabsError>;
  }
>()("t3/labs/LabsCli") {}

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const cliErrorText = (output: unknown): string | null =>
  typeof output === "object" &&
  output !== null &&
  "error" in output &&
  typeof output.error === "string" &&
  output.error.trim() !== ""
    ? output.error.trim()
    : null;

/** The last non-empty line, enough to say why a process died without dumping its output. */
const lastLine = (text: string): string | null =>
  text
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "") ?? null;

/** The env/argv that runs `args` with the inherited identity removed. */
const labsCliCommand = (input: Pick<LabsCliRunInput, "args" | "threadId">) => ({
  command: "env",
  args: [
    ...INHERITED_IDENTITY_ENV.flatMap((name) => ["-u", name]),
    ...(input.threadId === undefined ? [] : [`T3CODE_THREAD_ID=${input.threadId}`]),
    "bun",
    "--env-file=/dev/null",
    "src/cli.ts",
    ...input.args,
  ],
});

const make = Effect.gen(function* () {
  const processes = yield* ProcessRunner.ProcessRunner;
  return LabsCli.of({
    run: (input) => {
      const subcommand = input.args[0] ?? "";
      return processes
        .run({
          ...labsCliCommand(input),
          cwd: input.directory,
          timeout: input.timeout,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.mapError(
            () =>
              new LabsError({
                reason: "cli_failed",
                detail: `Could not run sp-labs ${subcommand} in ${input.directory}.`,
              }),
          ),
          Effect.flatMap((result) => {
            if (result.timedOut) {
              return Effect.fail(
                new LabsError({
                  reason: "timeout",
                  detail: `sp-labs ${subcommand} did not finish within ${Duration.format(Duration.fromInputUnsafe(input.timeout))}.`,
                }),
              );
            }
            const output = Option.getOrUndefined(parseJson(result.stdout));
            if (result.code !== 0) {
              return Effect.fail(
                new LabsError({
                  reason: "cli_failed",
                  detail:
                    cliErrorText(output) ??
                    lastLine(result.stderr) ??
                    `sp-labs ${subcommand} exited with code ${result.code ?? "unknown"}.`,
                }),
              );
            }
            return output === undefined
              ? Effect.fail(
                  new LabsError({
                    reason: "invalid_output",
                    detail: `sp-labs ${subcommand} printed no JSON.`,
                  }),
                )
              : Effect.succeed(output);
          }),
        );
    },
  });
});

export const layer = Layer.effect(LabsCli, make);
