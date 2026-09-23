import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const MAC_DEV_APP_ID = "com.t3tools.t3code.dev";

export class MacDevSigningError extends Data.TaggedError("MacDevSigningError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const decodeTeamId = Schema.decodeUnknownEffect(
  Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/u)),
);

export const resolveMacDevSigningTeam = Effect.fn("resolveMacDevSigningTeam")(function* (
  env: Readonly<Record<string, string | undefined>>,
) {
  return yield* decodeTeamId(env.T3CODE_DESKTOP_MAC_TEAM_ID?.trim()).pipe(
    Effect.mapError(
      (cause) =>
        new MacDevSigningError({
          message:
            "macOS Dev builds require T3CODE_DESKTOP_MAC_TEAM_ID in .env.local or the environment, and a Developer ID Application certificate with its private key in Keychain. See docs/operations/development.md#signed-macos-dev-builds.",
          cause,
        }),
    ),
  );
});

// Match Apple's Developer ID identity across rebuilds and certificate renewals,
// rather than trusting an ad hoc cdhash or a certificate from another team.
export function macDevSigningRequirement(teamId: string): string {
  return `identifier "${MAC_DEV_APP_ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`;
}

export const verifyMacDevSignature = Effect.fn("verifyMacDevSignature")(function* (
  appPath: string,
  teamId: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(
      "/usr/bin/codesign",
      [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        "-R",
        `=${macDevSigningRequirement(teamId)}`,
        appPath,
      ],
      { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    ),
  );
  if (Number(exitCode) !== 0) {
    return yield* new MacDevSigningError({
      message: `Refusing macOS Dev app with an invalid signature or unexpected signing identity: ${appPath}`,
    });
  }
});
