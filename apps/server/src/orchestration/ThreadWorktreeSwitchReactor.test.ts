import { CommandId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../persistence/Services/ProjectionThreads.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadWorktreeSwitchReactor from "./ThreadWorktreeSwitchReactor.ts";

const now = "2026-09-14T04:00:00.000Z";
const threadId = ThreadId.make("switch");
const projectId = ProjectId.make("project");
const requestId = CommandId.make("request");

it.effect.each(["recovery", "read", "dispatch"] as const)(
  "retries a transient %s failure without another domain event",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const failed = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const attempts = { recovery: 0, read: 0, dispatch: 0 };
        const attempt = Effect.fn(function* (operation: keyof typeof attempts) {
          attempts[operation]++;
          if (scenario === operation && attempts[operation] === 1) {
            yield* Deferred.succeed(failed, undefined);
            return yield* Effect.fail(
              new PersistenceSqlError({ operation, detail: "Transient failure" }),
            );
          }
        });
        const row: ProjectionThread = {
          threadId,
          projectId,
          title: "Switch",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature",
          worktreePath: "/repo/worktree",
          latestTurnId: TurnId.make("turn"),
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
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
          worktreeSwitch: {
            requestId,
            turnId: TurnId.make("turn"),
            sourceWorktreePath: "/repo/worktree",
            sourceBranch: "feature",
            targetPath: "/repo/target",
            requestedAt: now,
            status: "pending",
          },
        };

        const dependencies = Layer.mergeAll(
          Layer.mock(ProjectionThreadRepository)({
            getById: () => attempt("read").pipe(Effect.as(Option.some(row))),
            listPendingWorktreeSwitches: () => attempt("recovery").pipe(Effect.as([threadId])),
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            getProjectShellById: () => Effect.succeed(Option.none()),
          }),
          Layer.mock(OrchestrationEngineService)({
            subscribeDomainEvents: Effect.succeed(Stream.never),
            dispatch: (command) =>
              Effect.gen(function* () {
                expect(command).toMatchObject({
                  type: "thread.worktree-switch.execute",
                  threadId,
                  requestId,
                  error: "The project no longer exists.",
                });
                yield* attempt("dispatch");
                yield* Deferred.succeed(completed, undefined);
                return { sequence: 2 };
              }),
          }),
          NodeServices.layer,
        );
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadWorktreeSwitchReactor.ThreadWorktreeSwitchReactor;
          yield* reactor.start();
          yield* Deferred.await(failed);
          yield* TestClock.adjust("100 millis");
          yield* Deferred.await(completed);
          yield* reactor.drain;
          expect(attempts).toEqual({
            recovery: scenario === "recovery" ? 2 : 1,
            read: scenario === "recovery" ? 1 : 2,
            dispatch: scenario === "dispatch" ? 2 : 1,
          });
        }).pipe(
          Effect.provide(ThreadWorktreeSwitchReactor.layer.pipe(Layer.provide(dependencies))),
        );
      }),
    ),
);
