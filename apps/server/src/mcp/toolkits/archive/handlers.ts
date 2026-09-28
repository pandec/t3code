import { CommandId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ArchiveToolkit, ThreadArchiveError } from "./tools.ts";

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const readThread = Effect.gen(function* () {
    const scope = yield* McpInvocationContext;
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId, { includeArchived: true })
      .pipe(
        Effect.mapError(() => new ThreadArchiveError({ message: "Could not read this thread." })),
      );
    if (Option.isNone(thread))
      return yield* new ThreadArchiveError({ message: "This thread no longer exists." });
    if (thread.value.session?.providerInstanceId !== scope.providerInstanceId)
      return yield* new ThreadArchiveError({ message: "This provider no longer owns the thread." });
    return thread.value;
  });
  const status = readThread.pipe(
    Effect.map((thread) => ({
      archivedAt: thread.archivedAt,
      request: thread.archiveRequest ?? null,
    })),
  );
  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine
      .dispatch(command)
      .pipe(Effect.mapError((cause) => new ThreadArchiveError({ message: cause.message })));
  return ArchiveToolkit.of({
    archive_thread: (input) =>
      Effect.gen(function* () {
        const thread = yield* readThread;
        yield* dispatch({
          type: "thread.archive.schedule",
          commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
          threadId: thread.id,
          afterTurn: true,
          removeWorktree: input.removeWorktree ?? false,
        });
        return yield* status;
      }),
    archive_thread_status: () => status,
    cancel_thread_archive: () =>
      Effect.gen(function* () {
        const thread = yield* readThread;
        if (thread.archiveRequest?.status === "pending")
          yield* dispatch({
            type: "thread.archive.cancel",
            commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
            threadId: thread.id,
          });
        return yield* status;
      }),
  });
});

export const ArchiveToolkitHandlersLive = ArchiveToolkit.toLayer(make);
