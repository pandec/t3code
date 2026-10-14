import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as LabsCli from "./LabsCli.ts";

const output = (stdout: string, code: number): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const runWith = (result: ProcessRunner.ProcessRunOutput, seen: ProcessRunner.ProcessRunInput[]) =>
  Effect.gen(function* () {
    const cli = yield* LabsCli.LabsCli;
    return yield* cli.run({
      directory: "/fake/sp-labs",
      args: ["acquire", "sp-lab-1", "--purpose", "x"],
      threadId: ThreadId.make("thread-1"),
      timeout: "1 minute",
    });
  }).pipe(
    Effect.provide(
      LabsCli.layer.pipe(
        Layer.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: (input) => Effect.sync(() => (seen.push(input), result)),
          }),
        ),
      ),
    ),
  );

describe("LabsCli", () => {
  it.effect("drops inherited identity and sets the owning thread explicitly", () =>
    Effect.gen(function* () {
      const seen: ProcessRunner.ProcessRunInput[] = [];
      const parsed = yield* runWith(output('{ "lease": { "id": "l" } }', 0), seen);
      assert.deepEqual(parsed, { lease: { id: "l" } });
      const [call] = seen;
      assert.equal(call!.command, "env");
      assert.equal(call!.cwd, "/fake/sp-labs");
      const args = call!.args;
      assert.deepEqual(args.slice(0, 2), ["-u", "T3CODE_THREAD_ID"]);
      assert.isTrue(args.includes("T3CODE_TURN_ID"));
      assert.deepEqual(args.slice(args.indexOf("T3CODE_THREAD_ID=thread-1")), [
        "T3CODE_THREAD_ID=thread-1",
        "bun",
        "--env-file=/dev/null",
        "src/cli.ts",
        "acquire",
        "sp-lab-1",
        "--purpose",
        "x",
      ]);
    }),
  );

  it.effect("fails with the CLI's own error text on a non-zero exit", () =>
    Effect.gen(function* () {
      const error = yield* runWith(
        output('{ "error": "sp-lab-1 is already reserved" }', 1),
        [],
      ).pipe(Effect.match({ onFailure: (failure) => failure, onSuccess: () => null }));
      assert.equal(error?.reason, "cli_failed");
      assert.equal(error?.message, "sp-lab-1 is already reserved");
    }),
  );
});
