import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../persistence/Services/ProjectionThreads.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadArchiveReactor from "./ThreadArchiveReactor.ts";

const now = "2026-09-09T04:00:00.000Z";
const threadId = ThreadId.make("archive");
const projectId = ProjectId.make("project");
const requestId = CommandId.make("request");

it.effect.each(["success", "dirty", "shared", "detached", "stop-failed"] as const)(
  "recovers archived cleanup on startup: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const completed = yield* Deferred.make<string | undefined>();
        const calls: string[] = [];
        const row: ProjectionThread = {
          threadId,
          projectId,
          title: "Archive",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature",
          worktreePath: "/repo/worktree",
          latestTurnId: TurnId.make("turn"),
          createdAt: now,
          updatedAt: now,
          archivedAt: now,
          settledOverride: null,
          settledAt: null,
          unsettledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: null,
          latestUserMessageAt: null,
          pendingApprovalCount: 0,
          pendingUserInputCount: 0,
          hasActionableProposedPlan: 0,
          deletedAt: null,
          archiveRequest: {
            requestId,
            turnId: TurnId.make("turn"),
            removeWorktree: true,
            worktreePath: "/repo/worktree",
            requestedAt: now,
            status: "pending",
          },
        };
        const other: OrchestrationThreadShell = {
          id: ThreadId.make("other"),
          projectId,
          title: "Other",
          modelSelection: row.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature",
          worktreePath: "/repo/worktree",
          latestTurn: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        };
        const dependencies = Layer.mergeAll(
          Layer.mock(ProjectionThreadRepository)({
            getById: () => Effect.succeed(Option.some(row)),
            listPendingArchives: () => Effect.succeed([threadId]),
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                updatedAt: now,
                threads: scenario === "shared" ? [other] : [],
                projects: [
                  {
                    id: projectId,
                    title: "Project",
                    workspaceRoot: "/repo",
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              }),
          }),
          Layer.mock(ProviderService)({
            listSessions: () =>
              Effect.succeed([
                {
                  provider: ProviderDriverKind.make("codex"),
                  threadId,
                  status: "ready",
                  runtimeMode: "full-access",
                  createdAt: now,
                  updatedAt: now,
                },
              ]),
            stopSession: () =>
              Effect.sync(() => calls.push("stop")).pipe(
                Effect.andThen(
                  scenario === "stop-failed" ? Effect.die("Cannot stop session") : Effect.void,
                ),
              ),
          }),
          Layer.mock(TerminalManager)({
            close: () =>
              Effect.sync(() => {
                calls.push("terminals");
              }),
          }),
          Layer.mock(GitVcsDriver)({
            statusDetailsLocal: (cwd) =>
              Effect.sync(() => {
                expect(cwd).toBe("/repo/worktree");
                calls.push("status");
                return {
                  isRepo: true,
                  hasOriginRemote: true,
                  isDefaultBranch: false,
                  branch: scenario === "detached" ? null : "feature",
                  upstreamRef: null,
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: false,
                  aheadCount: 0,
                  behindCount: 0,
                  aheadOfDefaultCount: 0,
                };
              }),
            removeWorktree: (input) =>
              Effect.sync(() => {
                expect(input).toEqual({ cwd: "/repo", path: "/repo/worktree" });
                calls.push("remove");
              }).pipe(
                Effect.andThen(
                  scenario === "dirty" ? Effect.die("Worktree is dirty") : Effect.void,
                ),
              ),
          }),
          Layer.mock(OrchestrationEngineService)({
            subscribeDomainEvents: Effect.succeed(Stream.never),
            dispatch: (command) => {
              if (command.type !== "thread.archive.complete")
                return Effect.die(`Unexpected ${command.type}`);
              expect(command.requestId).toBe(requestId);
              return Deferred.succeed(completed, command.error).pipe(Effect.as({ sequence: 2 }));
            },
          }),
          NodeServices.layer,
        );
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadArchiveReactor.ThreadArchiveReactor;
          yield* reactor.start();
          const error = yield* Deferred.await(completed);
          yield* reactor.drain;
          if (scenario === "success") {
            expect(error).toBeUndefined();
            expect(calls).toEqual(["stop", "terminals", "status", "remove"]);
          } else {
            expect(error).toContain(
              scenario === "dirty"
                ? "dirty"
                : scenario === "shared"
                  ? "Another unarchived thread"
                  : scenario === "detached"
                    ? "Detached"
                    : "Cannot stop",
            );
            expect(calls).toEqual(
              scenario === "dirty"
                ? ["stop", "terminals", "status", "remove"]
                : scenario === "shared" || scenario === "detached"
                  ? ["stop", "terminals", "status"]
                  : ["stop"],
            );
          }
        }).pipe(Effect.provide(ThreadArchiveReactor.layer.pipe(Layer.provide(dependencies))));
      }),
    ),
);
