import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { resolveClaudeConfigDirPath, resolveClaudeShadowConfigDirPath } from "./ClaudeHome.ts";

export interface ClaudeHomeLayout {
  readonly mode: "direct" | "authOverlay";
  /** Config dir holding shared session state; continuation is keyed on it. */
  readonly sharedConfigDirPath: string;
  /** Config dir the spawned CLI sees, when it differs from the shared dir. */
  readonly shadowConfigDirPath: string | undefined;
}

/**
 * Claude analog of the Codex shadow home (`CodexHomeLayout.ts`), kept as a
 * parallel module rather than a shared abstraction so the upstream Codex file
 * stays untouched.
 *
 * Unlike Codex — whose home holds a small, well-known set of directories — a
 * Claude config dir accumulates heterogeneous per-account state (`.claude.json`,
 * `session-env/`, security-warning markers, caches). The shadow overlay
 * therefore shares an explicit whitelist instead of enumerating the shared
 * dir: entries not listed here stay local to whichever config dir the CLI
 * writes them in.
 */
const REQUIRED_SHARED_DIRECTORIES = ["projects", "todos", "shell-snapshots"] as const;

/** Shared only when they already exist in the shared config dir. */
const OPTIONAL_SHARED_ENTRIES = [
  "agents",
  "commands",
  "skills",
  "plugins",
  "hooks",
  "docs",
  "CLAUDE.md",
  "settings.json",
  "history.jsonl",
  "keybindings.json",
  "statusline-command.sh",
] as const;

/**
 * Never shared: these carry the account identity of a config dir. A stale
 * hand-made symlink for one of them would silently collapse both instances
 * onto one account, so materialization removes such symlinks.
 */
const PRIVATE_ENTRY_NAMES = [".credentials.json", ".claude.json"] as const;

const ClaudeShadowHomeContext = {
  sharedConfigDirPath: Schema.String,
  shadowConfigDirPath: Schema.String,
};

export class ClaudeShadowHomeFileSystemError extends Schema.TaggedErrorClass<ClaudeShadowHomeFileSystemError>()(
  "ClaudeShadowHomeFileSystemError",
  {
    ...ClaudeShadowHomeContext,
    operation: Schema.Literals([
      "readLink",
      "makeDirectory",
      "realPath",
      "exists",
      "remove",
      "symlink",
    ]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Claude shadow config dir filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

export class ClaudeShadowHomePathConflictError extends Schema.TaggedErrorClass<ClaudeShadowHomePathConflictError>()(
  "ClaudeShadowHomePathConflictError",
  ClaudeShadowHomeContext,
) {
  override get message(): string {
    return `Claude shadow config dir '${this.shadowConfigDirPath}' must be separate from and not nested within the shared config dir '${this.sharedConfigDirPath}'.`;
  }
}

export class ClaudeShadowHomeEntryConflictError extends Schema.TaggedErrorClass<ClaudeShadowHomeEntryConflictError>()(
  "ClaudeShadowHomeEntryConflictError",
  {
    ...ClaudeShadowHomeContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Claude shadow config dir entry '${this.entryName}' at '${this.linkPath}' already exists and is not a symlink. Move its contents into '${this.targetPath}' (or remove it) so the shadow config dir can share the entry.`;
  }
}

export const ClaudeShadowHomeError = Schema.Union([
  ClaudeShadowHomeFileSystemError,
  ClaudeShadowHomePathConflictError,
  ClaudeShadowHomeEntryConflictError,
]);
export type ClaudeShadowHomeError = typeof ClaudeShadowHomeError.Type;

export const resolveClaudeHomeLayout = Effect.fn("resolveClaudeHomeLayout")(function* (
  config: Pick<ClaudeSettings, "homePath" | "shadowHomePath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ClaudeHomeLayout, never, Path.Path> {
  const sharedConfigDirPath = yield* resolveClaudeConfigDirPath(config, environment, cwd);
  const shadowConfigDirPath = yield* resolveClaudeShadowConfigDirPath(config);
  if (shadowConfigDirPath === undefined) {
    return { mode: "direct", sharedConfigDirPath, shadowConfigDirPath: undefined };
  }
  return { mode: "authOverlay", sharedConfigDirPath, shadowConfigDirPath };
});

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

function pathsOverlap(path: Path.Path, first: string, second: string): boolean {
  const relative = path.relative(first, second);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

const readLinkState = Effect.fn("ClaudeHomeLayout.readLinkState")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedConfigDirPath: string;
  readonly shadowConfigDirPath: string;
  readonly entryName: string;
  readonly linkPath: string;
}): Effect.fn.Return<LinkState, ClaudeShadowHomeError> {
  return yield* input.fileSystem.readLink(input.linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed<LinkState>({ _tag: "Missing" });
        }
        if (isNotSymlinkError(cause)) {
          return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        }
        return new ClaudeShadowHomeFileSystemError({
          sharedConfigDirPath: input.sharedConfigDirPath,
          shadowConfigDirPath: input.shadowConfigDirPath,
          operation: "readLink",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );
});

const removePrivateSymlink = Effect.fn("ClaudeHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedConfigDirPath: string;
  readonly shadowConfigDirPath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, ClaudeShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.shadowConfigDirPath, input.entryName);
  const state = yield* readLinkState({ ...input, linkPath: privatePath });
  if (state._tag === "Symlink") {
    yield* input.fileSystem.remove(privatePath).pipe(
      Effect.catchTags({
        PlatformError: (cause) => {
          if (cause.reason._tag === "NotFound") return Effect.void;
          return new ClaudeShadowHomeFileSystemError({
            sharedConfigDirPath: input.sharedConfigDirPath,
            shadowConfigDirPath: input.shadowConfigDirPath,
            operation: "remove",
            path: privatePath,
            entryName: input.entryName,
            cause,
          });
        },
      }),
    );
  }
});

const validateSharedEntry = Effect.fn("ClaudeHomeLayout.validateSharedEntry")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedConfigDirPath: string;
  readonly shadowConfigDirPath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, ClaudeShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const targetPath = path.join(input.sharedConfigDirPath, input.entryName);
  const linkPath = path.join(input.shadowConfigDirPath, input.entryName);
  const state = yield* readLinkState({ ...input, linkPath });
  if (state._tag === "NotSymlink") {
    return yield* new ClaudeShadowHomeEntryConflictError({
      sharedConfigDirPath: input.sharedConfigDirPath,
      shadowConfigDirPath: input.shadowConfigDirPath,
      entryName: input.entryName,
      linkPath,
      targetPath,
    });
  }
});

const removeStaleOptionalSymlink = Effect.fn("ClaudeHomeLayout.removeStaleOptionalSymlink")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedConfigDirPath: string;
    readonly shadowConfigDirPath: string;
    readonly entryName: string;
  }): Effect.fn.Return<void, ClaudeShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const targetPath = path.join(input.sharedConfigDirPath, input.entryName);
    const linkPath = path.join(input.shadowConfigDirPath, input.entryName);
    const state = yield* readLinkState({ ...input, linkPath });
    if (
      state._tag !== "Symlink" ||
      path.resolve(path.dirname(linkPath), state.target) !== targetPath
    ) {
      return;
    }
    yield* input.fileSystem.remove(linkPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) => {
          if (cause.reason._tag === "NotFound") return Effect.void;
          return new ClaudeShadowHomeFileSystemError({
            sharedConfigDirPath: input.sharedConfigDirPath,
            shadowConfigDirPath: input.shadowConfigDirPath,
            operation: "remove",
            path: linkPath,
            entryName: input.entryName,
            cause,
          });
        },
      }),
    );
  },
);

const ensureSymlink = Effect.fn("ClaudeHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedConfigDirPath: string;
  readonly shadowConfigDirPath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, ClaudeShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedConfigDirPath, input.entryName);
  const link = path.join(input.shadowConfigDirPath, input.entryName);
  const state = yield* readLinkState({ ...input, linkPath: link });

  const createLink = input.fileSystem.symlink(target, link).pipe(
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "AlreadyExists") {
          return readLinkState({ ...input, linkPath: link }).pipe(
            Effect.flatMap((currentState): Effect.Effect<void, ClaudeShadowHomeError> => {
              if (
                currentState._tag === "Symlink" &&
                path.resolve(path.dirname(link), currentState.target) === target
              ) {
                return Effect.void;
              }
              if (currentState._tag === "NotSymlink") {
                return new ClaudeShadowHomeEntryConflictError({
                  sharedConfigDirPath: input.sharedConfigDirPath,
                  shadowConfigDirPath: input.shadowConfigDirPath,
                  entryName: input.entryName,
                  linkPath: link,
                  targetPath: target,
                });
              }
              return new ClaudeShadowHomeFileSystemError({
                sharedConfigDirPath: input.sharedConfigDirPath,
                shadowConfigDirPath: input.shadowConfigDirPath,
                operation: "symlink",
                path: link,
                targetPath: target,
                entryName: input.entryName,
                cause,
              });
            }),
          );
        }
        return new ClaudeShadowHomeFileSystemError({
          sharedConfigDirPath: input.sharedConfigDirPath,
          shadowConfigDirPath: input.shadowConfigDirPath,
          operation: "symlink",
          path: link,
          targetPath: target,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );

  if (state._tag === "NotSymlink") {
    return yield* new ClaudeShadowHomeEntryConflictError({
      sharedConfigDirPath: input.sharedConfigDirPath,
      shadowConfigDirPath: input.shadowConfigDirPath,
      entryName: input.entryName,
      linkPath: link,
      targetPath: target,
    });
  }

  if (state._tag === "Missing") {
    return yield* createLink;
  }

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (resolvedExisting !== target) {
    yield* input.fileSystem.remove(link).pipe(
      Effect.catchTags({
        PlatformError: (cause) => {
          if (cause.reason._tag === "NotFound") return Effect.void;
          return new ClaudeShadowHomeFileSystemError({
            sharedConfigDirPath: input.sharedConfigDirPath,
            shadowConfigDirPath: input.shadowConfigDirPath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          });
        },
      }),
    );
    yield* createLink;
  }
});

/**
 * Materialize the shadow config dir: create it (and the shared dir) if
 * missing, symlink shared session state and configuration into it, and drop
 * stale symlinks for account-private entries. Idempotent — an already
 * materialized shadow dir (including a hand-made one with matching symlinks)
 * is left as is.
 */
export const materializeClaudeShadowHome = Effect.fn("materializeClaudeShadowHome")(function* (
  layout: ClaudeHomeLayout,
) {
  if (layout.mode !== "authOverlay") return;
  const shadowConfigDirPath = layout.shadowConfigDirPath;
  if (!shadowConfigDirPath) return;
  if (layout.sharedConfigDirPath === shadowConfigDirPath) {
    return yield* new ClaudeShadowHomePathConflictError({
      sharedConfigDirPath: layout.sharedConfigDirPath,
      shadowConfigDirPath,
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    pathsOverlap(path, layout.sharedConfigDirPath, shadowConfigDirPath) ||
    pathsOverlap(path, shadowConfigDirPath, layout.sharedConfigDirPath)
  ) {
    return yield* new ClaudeShadowHomePathConflictError({
      sharedConfigDirPath: layout.sharedConfigDirPath,
      shadowConfigDirPath,
    });
  }

  const makeDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new ClaudeShadowHomeFileSystemError({
            sharedConfigDirPath: layout.sharedConfigDirPath,
            shadowConfigDirPath,
            operation: "makeDirectory",
            path: directoryPath,
            cause,
          }),
      }),
    );

  yield* Effect.all(
    [
      makeDirectory(layout.sharedConfigDirPath),
      makeDirectory(shadowConfigDirPath),
      ...REQUIRED_SHARED_DIRECTORIES.map((directory) =>
        makeDirectory(path.join(layout.sharedConfigDirPath, directory)),
      ),
    ],
    { concurrency: "unbounded" },
  );

  const realPath = (directoryPath: string) =>
    fileSystem.realPath(directoryPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new ClaudeShadowHomeFileSystemError({
            sharedConfigDirPath: layout.sharedConfigDirPath,
            shadowConfigDirPath,
            operation: "realPath",
            path: directoryPath,
            cause,
          }),
      }),
    );
  const [canonicalSharedConfigDirPath, canonicalShadowConfigDirPath] = yield* Effect.all([
    realPath(layout.sharedConfigDirPath),
    realPath(shadowConfigDirPath),
  ]);
  if (
    pathsOverlap(path, canonicalSharedConfigDirPath, canonicalShadowConfigDirPath) ||
    pathsOverlap(path, canonicalShadowConfigDirPath, canonicalSharedConfigDirPath)
  ) {
    return yield* new ClaudeShadowHomePathConflictError({
      sharedConfigDirPath: layout.sharedConfigDirPath,
      shadowConfigDirPath,
    });
  }

  const optionalEntryStates = yield* Effect.forEach(
    OPTIONAL_SHARED_ENTRIES,
    (entryName) =>
      fileSystem.exists(path.join(layout.sharedConfigDirPath, entryName)).pipe(
        Effect.map((exists) => ({ entryName, exists })),
        Effect.catchTags({
          PlatformError: (cause) =>
            new ClaudeShadowHomeFileSystemError({
              sharedConfigDirPath: layout.sharedConfigDirPath,
              shadowConfigDirPath,
              operation: "exists",
              path: path.join(layout.sharedConfigDirPath, entryName),
              entryName,
              cause,
            }),
        }),
      ),
    { concurrency: "unbounded" },
  );

  const sharedEntryNames = [
    ...REQUIRED_SHARED_DIRECTORIES,
    ...optionalEntryStates.filter(({ exists }) => exists).map(({ entryName }) => entryName),
  ];

  // Validate every known conflict before changing existing shadow entries.
  yield* Effect.forEach(
    sharedEntryNames,
    (entryName) =>
      validateSharedEntry({
        fileSystem,
        sharedConfigDirPath: layout.sharedConfigDirPath,
        shadowConfigDirPath,
        entryName,
      }),
    { discard: true },
  );

  yield* Effect.forEach(
    optionalEntryStates.filter(({ exists }) => !exists),
    ({ entryName }) =>
      removeStaleOptionalSymlink({
        fileSystem,
        sharedConfigDirPath: layout.sharedConfigDirPath,
        shadowConfigDirPath,
        entryName,
      }),
    { discard: true },
  );

  yield* Effect.forEach(
    PRIVATE_ENTRY_NAMES,
    (entryName) =>
      removePrivateSymlink({
        fileSystem,
        sharedConfigDirPath: layout.sharedConfigDirPath,
        shadowConfigDirPath,
        entryName,
      }),
    { discard: true },
  );

  yield* Effect.forEach(
    sharedEntryNames,
    (entryName) =>
      ensureSymlink({
        fileSystem,
        sharedConfigDirPath: layout.sharedConfigDirPath,
        shadowConfigDirPath,
        entryName,
      }),
    { discard: true },
  );
});
