import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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

export const unlockMacDevKeychain = Effect.fn("unlockMacDevKeychain")(function* (
  env: Readonly<Record<string, string | undefined>>,
) {
  const keychain = env.T3CODE_DESKTOP_MAC_KEYCHAIN?.trim();
  const passwordFile = env.T3CODE_DESKTOP_MAC_KEYCHAIN_PASSWORD_FILE?.trim();
  if (!keychain && !passwordFile) return undefined;

  const path = yield* Path.Path;
  if (!keychain || !passwordFile || !path.isAbsolute(keychain) || !path.isAbsolute(passwordFile)) {
    return yield* new MacDevSigningError({
      message:
        "Set both T3CODE_DESKTOP_MAC_KEYCHAIN and T3CODE_DESKTOP_MAC_KEYCHAIN_PASSWORD_FILE to absolute machine-local paths for unattended signing.",
    });
  }

  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Neither subprocess errors nor output may carry the password into build logs.
  yield* Effect.gen(function* () {
    const info = yield* fs.stat(passwordFile);
    if (info.type !== "File" || (info.mode & 0o077) !== 0) {
      return yield* new MacDevSigningError({
        message:
          "The macOS signing password file must be a regular file accessible only to its owner (chmod 600).",
      });
    }
    const password = (yield* fs.readFileString(passwordFile)).replace(/\r?\n$/u, "");
    if (!password) {
      return yield* new MacDevSigningError({
        message: "The macOS signing password file is empty.",
      });
    }
    const code = yield* spawner.exitCode(
      ChildProcess.make("/usr/bin/security", ["unlock-keychain", keychain], {
        // Without a controlling terminal, security reads its password prompt from stdin.
        // Keep the credential out of process arguments and the environment.
        detached: true,
        stdin: Stream.make(new TextEncoder().encode(`${password}\n`)),
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    if (Number(code) !== 0) {
      return yield* new MacDevSigningError({
        message: "Could not unlock the macOS build keychain.",
      });
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof MacDevSigningError
        ? error
        : new MacDevSigningError({
            message:
              "Could not unlock the macOS build keychain. Check its path, password file, and file permissions; no credential details were logged.",
          }),
    ),
  );
  return keychain;
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
