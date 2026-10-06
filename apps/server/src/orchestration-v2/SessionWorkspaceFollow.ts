/**
 * Fork (DECISIONS 5.8): a thread follows a provider session that moved itself
 * into another checkout of the project (Claude's EnterWorktree/ExitWorktree).
 *
 * The adapter notices the move and offers a ProviderSessionCwdObservation; this worker
 * mirrors it onto the thread's branch and worktree with the internal
 * `thread.workspace.follow-session` command, which names the session process,
 * so the decider keeps it running instead of detaching it as it does for a
 * T3-driven move.
 * Later turns, and any session restart, then start in the directory the
 * session is actually in.
 */
import type { OrchestrationV2AppThread, OrchestrationV2ProviderSession } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { isExistingDirectory } from "../pathExpansion.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import {
  type ProviderSessionCwdObservation,
  ProviderSessionCwdObservations,
} from "./ProviderSessionCwdObservations.ts";
import { resolveWorktreeSwitchTarget } from "./worktreeSwitch.ts";

/**
 * The thread workspace an observed session cwd stands for. Only an existing
 * checkout of the project's repository qualifies: a plain subdirectory or
 * another repository would retarget the thread's diffs, checkpoints and git
 * status at the wrong code, and a directory removed since the move would make
 * every later turn fail to start.
 */
export const resolveFollowedWorkspace = Effect.fn("resolveFollowedWorkspace")(function* (input: {
  readonly workspaceRoot: string;
  readonly cwd: string;
}) {
  if (!isExistingDirectory(input.cwd)) {
    return Option.none<{ readonly worktreePath: string | null; readonly branch: string | null }>();
  }
  return yield* resolveWorktreeSwitchTarget(input.workspaceRoot, input.cwd).pipe(
    Effect.map((target) =>
      Option.some({ worktreePath: target.worktreePath, branch: target.branch }),
    ),
    Effect.catchTags({
      WorktreeSwitchError: () =>
        Effect.succeed(
          Option.none<{ readonly worktreePath: string | null; readonly branch: string | null }>(),
        ),
    }),
  );
});

/**
 * The metadata update that makes a thread follow an observed move, or none
 * when the observation no longer applies. Only the process that moved may move
 * the thread: a later process reusing the session id runs where T3 put it.
 */
export const planSessionWorkspaceFollow = Effect.fn("planSessionWorkspaceFollow")(
  function* (input: {
    readonly observation: ProviderSessionCwdObservation;
    readonly thread: Pick<
      OrchestrationV2AppThread,
      "archivedAt" | "deletedAt" | "worktreePath" | "branch"
    >;
    readonly providerSessions: ReadonlyArray<OrchestrationV2ProviderSession>;
    readonly workspaceRoot: string;
  }) {
    const { observation, thread } = input;
    const none = Option.none<{
      readonly worktreePath: string | null;
      readonly branch: string | null;
      readonly expectedWorktreePath: string | null;
    }>();
    if (thread.archivedAt !== null || thread.deletedAt !== null) return none;
    const observingProcessLive = input.providerSessions.some(
      (session) =>
        session.id === observation.providerSessionId &&
        session.status !== "stopped" &&
        session.status !== "error" &&
        DateTime.toEpochMillis(session.createdAt) ===
          DateTime.toEpochMillis(observation.providerSessionCreatedAt),
    );
    if (!observingProcessLive) return none;
    const followed = yield* resolveFollowedWorkspace({
      workspaceRoot: input.workspaceRoot,
      cwd: observation.cwd,
    });
    if (Option.isNone(followed)) return none;
    const { worktreePath, branch } = followed.value;
    if (worktreePath === thread.worktreePath && branch === thread.branch) return none;
    return Option.some({ worktreePath, branch, expectedWorktreePath: thread.worktreePath });
  },
);

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const observations = yield* ProviderSessionCwdObservations;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const follow = Effect.fn("SessionWorkspaceFollow.follow")(function* (
      observation: ProviderSessionCwdObservation,
    ) {
      // One read: the sessions checked and the worktree the update expects
      // come from the same projection, so a T3 move after it is rejected.
      const { thread, providerSessions } = yield* orchestrator.getThreadRecords(
        observation.threadId,
        ["providerSessions"],
      );
      const project = yield* projects.get(thread.projectId);
      if (Option.isNone(project)) return;
      const plan = yield* planSessionWorkspaceFollow({
        observation,
        thread,
        providerSessions,
        workspaceRoot: project.value.workspaceRoot,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      if (Option.isNone(plan)) {
        yield* Effect.logDebug("orchestration-v2.session-workspace-follow.skipped", {
          threadId: observation.threadId,
          providerSessionId: observation.providerSessionId,
          cwd: observation.cwd,
        });
        return;
      }
      yield* orchestrator.dispatch({
        type: "thread.workspace.follow-session",
        commandId: yield* ids.allocate.command({
          fixtureName: "session-workspace-follow",
          commandName: "metadata-update",
        }),
        threadId: observation.threadId,
        ...plan.value,
        providerSessionId: observation.providerSessionId,
        providerSessionCreatedAt: observation.providerSessionCreatedAt,
      });
    });

    yield* observations.take.pipe(
      Effect.flatMap((observation) =>
        follow(observation).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.session-workspace-follow.failed", {
              threadId: observation.threadId,
              cwd: observation.cwd,
              cause,
            }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
