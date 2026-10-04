/**
 * Fork: guarded worktree removal for archive requests with `removeWorktree`.
 * Removes only a clean, attached, linked worktree that is not a project
 * checkout and that no other unarchived thread uses. Removal is never forced
 * (Git also keeps locked worktrees) and the branch is always kept. Callers get
 * the reason a worktree was kept instead of an error.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  canonicalWorkspacePath,
  reserveWorkspace,
  withWorkspaceLease,
} from "../workspace/workspaceLease.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { ResourceCleanupService } from "./ResourceCleanupService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const WORKTREE_KEPT_DETAIL = {
  noWorktree: "This thread has no worktree to remove.",
  notWorktree:
    "Only linked Git worktrees can be removed; this path is a main checkout or not a repository.",
  projectCheckout: "Refusing to remove a project checkout.",
  noProject: "The thread's project no longer exists.",
  shared: "Another unarchived thread uses this worktree.",
  detached: "Detached worktrees need manual removal to keep unreferenced commits.",
  dirty: "The worktree has uncommitted or untracked changes.",
  busy: "Another operation is using this worktree. Archive again after it finishes.",
  gitRefused: "Git refused to remove the worktree; it may be locked.",
} as const;

export class ArchiveWorktreeRemoval extends Context.Service<
  ArchiveWorktreeRemoval,
  {
    /**
     * Why `threadId`'s worktree could not be removed, ignoring uncommitted
     * changes (a running turn may still commit them); null when allowed.
     */
    readonly blocker: (threadId: ThreadId) => Effect.Effect<string | null>;
    /**
     * Stops the archived thread's terminals and provider sessions, then removes
     * `worktreePath` if every guard passes. Returns why it was kept, or null
     * once it is gone.
     */
    readonly remove: (input: {
      readonly threadId: ThreadId;
      readonly worktreePath: string;
    }) => Effect.Effect<string | null>;
  }
>()("t3/orchestration-v2/ArchiveWorktreeRemoval") {}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const resourceCleanup = yield* ResourceCleanupService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const contains = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  /** Guards that hold regardless of the working tree's contents. */
  const structuralBlocker = Effect.fn("ArchiveWorktreeRemoval.structuralBlocker")(function* (
    threadId: ThreadId,
    worktreePath: string,
  ) {
    const root = yield* canonicalWorkspacePath(worktreePath);
    // A linked worktree has a `.git` file; a main checkout has a directory.
    const gitEntry = yield* fs.stat(path.join(root, ".git")).pipe(Effect.orElseSucceed(() => null));
    if (gitEntry?.type !== "File") return WORKTREE_KEPT_DETAIL.notWorktree;
    const projectShells = yield* projects.listShells();
    for (const project of projectShells) {
      if (contains(root, yield* canonicalWorkspacePath(project.workspaceRoot))) {
        return WORKTREE_KEPT_DETAIL.projectCheckout;
      }
    }
    const active = yield* threads.getShellSnapshot({ location: "active" });
    for (const thread of active.threads) {
      if (thread.id === threadId || thread.deletedAt !== null) continue;
      const cwd =
        thread.worktreePath ??
        projectShells.find((project) => project.id === thread.projectId)?.workspaceRoot;
      if (cwd !== undefined && contains(root, yield* canonicalWorkspacePath(cwd))) {
        return WORKTREE_KEPT_DETAIL.shared;
      }
    }
    // Read the live checkout: thread metadata does not track a detached HEAD.
    const status = yield* git.statusDetailsLocal(root, { includeDivergence: false });
    if (!status.isRepo) return WORKTREE_KEPT_DETAIL.notWorktree;
    if (status.branch === null) return WORKTREE_KEPT_DETAIL.detached;
    return status.hasWorkingTreeChanges ? WORKTREE_KEPT_DETAIL.dirty : null;
  });

  // The workspace lease helpers resolve paths through the platform services.
  const providePlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const describeFailure =
    (operation: "check" | "removal") =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | string, never, R> =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning(`archive worktree ${operation} failed`, { error }).pipe(
            Effect.as(`The worktree ${operation} failed; the worktree was kept.`),
          ),
        ),
      );

  const blocker = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const { thread } = yield* threads.getThreadRecords(threadId, []);
      if (thread.worktreePath === null) return WORKTREE_KEPT_DETAIL.noWorktree;
      if (!(yield* fs.exists(thread.worktreePath))) return null;
      const reason = yield* structuralBlocker(threadId, thread.worktreePath);
      return reason === WORKTREE_KEPT_DETAIL.dirty ? null : reason;
    }).pipe(describeFailure("check"), providePlatform);

  const remove = (input: { readonly threadId: ThreadId; readonly worktreePath: string }) =>
    Effect.gen(function* () {
      const { thread, providerSessions: sessions } = yield* threads.getThreadRecords(
        input.threadId,
        ["providerSessions"],
      );
      // The archive already queued these stops as effects; repeating them
      // (both are idempotent) keeps processes out of the checkout first.
      yield* resourceCleanup.cleanupTerminals(input.threadId);
      yield* Effect.forEach(
        sessions.filter((session) => session.status !== "stopped"),
        (session) =>
          providerSessions.detach({
            providerSessionId: session.id,
            threadId: input.threadId,
            detail: "Thread archived.",
            revokeMcpCredential: true,
          }),
        { discard: true },
      );
      const project = yield* projects.getShell(thread.projectId);
      if (Option.isNone(project)) return WORKTREE_KEPT_DETAIL.noProject;
      const projectRoot = project.value.workspaceRoot;
      return yield* withWorkspaceLease(
        input.worktreePath,
        Effect.gen(function* () {
          if (!(yield* reserveWorkspace(input.worktreePath, "removal"))) {
            return WORKTREE_KEPT_DETAIL.busy;
          }
          if (!(yield* fs.exists(input.worktreePath))) return null;
          const reason = yield* structuralBlocker(input.threadId, input.worktreePath);
          if (reason !== null) return reason;
          return yield* git
            .removeWorktree({ cwd: projectRoot, path: input.worktreePath, force: false })
            .pipe(
              Effect.as(null),
              Effect.catchTag("GitCommandError", () =>
                Effect.succeed(WORKTREE_KEPT_DETAIL.gitRefused),
              ),
            );
        }).pipe(Effect.scoped),
      );
    }).pipe(describeFailure("removal"), providePlatform);

  return ArchiveWorktreeRemoval.of({ blocker, remove });
});

export const layer = Layer.effect(ArchiveWorktreeRemoval, make);
