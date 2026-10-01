import {
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

/** Share scratch-folder preparation between WebSocket and HTTP/CLI dispatch. */
export const makeScratchWorkspace = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const gitWorkflow = yield* GitWorkflowService;
  const query = yield* ProjectionSnapshotQuery;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;

  // A data directory inside a checkout would inherit that repository's status
  // and checkpoints. Failed detection hides Scratch; interruption stays retryable.
  const [cachedRoot, invalidateRoot] = yield* Effect.cachedInvalidateWithTTL(
    gitWorkflow.isRepository(config.baseDir).pipe(
      Effect.map((isRepository) =>
        isRepository ? undefined : path.resolve(config.baseDir, "scratch"),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined),
      ),
    ),
    Duration.infinity,
  );
  const resolveWorkspaceRoot = cachedRoot.pipe(Effect.onInterrupt(() => invalidateRoot));

  const threadFolder = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
    readonly createdAt: string;
    readonly text: string;
  }) {
    if (input.worktreePath !== null) return null;
    const scratchRoot = yield* resolveWorkspaceRoot;
    if (scratchRoot === undefined) return null;
    const project = yield* query.getProjectShellById(input.projectId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Failed to look up the thread's project.",
            cause,
          }),
      ),
    );
    if (
      Option.isNone(project) ||
      normalizeProjectPathForComparison(project.value.workspaceRoot) !==
        normalizeProjectPathForComparison(scratchRoot)
    )
      return null;

    // Claim each leaf non-recursively. Short-ID collisions fall back to the
    // full ID; sanitized, capped words never escape the scratch root.
    const words = input.text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .slice(0, 5)
      .join("-")
      .slice(0, 48)
      .replace(/-+$/, "");
    const id = input.threadId.toLowerCase().replace(/[^a-z0-9]/g, "");
    const folderFor = (idPart: string) =>
      path.join(
        scratchRoot,
        [input.createdAt.slice(0, 10), words, idPart].filter(Boolean).join("-"),
      );
    yield* fileSystem.makeDirectory(scratchRoot, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Failed to create the folder for threads without a project.",
            cause,
          }),
      ),
    );
    const claim = (folder: string) =>
      fileSystem.makeDirectory(folder).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: "Failed to create the thread's folder.",
              cause,
            }),
        ),
      );
    const shortFolder = folderFor(id.slice(0, 8));
    if (yield* claim(shortFolder)) return shortFolder;
    const fullFolder = folderFor(id);
    yield* claim(fullFolder);
    return fullFolder;
  });

  const prepareCommand = (
    command: OrchestrationCommand,
  ): Effect.Effect<OrchestrationCommand, OrchestrationDispatchCommandError> => {
    if (command.type === "thread.create") {
      return threadFolder({ ...command, text: command.title }).pipe(
        Effect.map((worktreePath) =>
          worktreePath === null ? command : { ...command, worktreePath },
        ),
      );
    }
    if (command.type !== "thread.turn.start") return Effect.succeed(command);
    const bootstrap = command.bootstrap;
    const createThread = bootstrap?.createThread;
    if (bootstrap === undefined || createThread === undefined) return Effect.succeed(command);
    return threadFolder({
      ...createThread,
      threadId: command.threadId,
      text: command.message.text,
    }).pipe(
      Effect.map((worktreePath) =>
        worktreePath === null
          ? command
          : {
              ...command,
              bootstrap: { ...bootstrap, createThread: { ...createThread, worktreePath } },
            },
      ),
    );
  };

  return { resolveWorkspaceRoot, prepareCommand };
});
