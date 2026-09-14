// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { WorktreeToolkitHandlersLive } from "./handlers.ts";
import { WorktreeToolkit } from "./tools.ts";

const threadId = ThreadId.make("own-thread");
const projectId = ProjectId.make("project");
const instanceId = ProviderInstanceId.make("codex");
const turnId = TurnId.make("turn");
const now = "2026-09-14T10:00:00.000Z";

it.effect.each([
  "worktree",
  "root",
  "relative",
  "subdirectory",
  "unrelated",
  "missing",
  "wrong-provider",
] as const)(
  "switch_worktree validates %s and only schedules its authenticated thread",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const path = NodeFS.realpathSync(
              NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-worktree-")),
            );
            NodeChildProcess.execFileSync("git", ["init", "-b", "dev", path], { stdio: "ignore" });
            NodeChildProcess.execFileSync(
              "git",
              [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
              ],
              { cwd: path, stdio: "ignore" },
            );
            NodeChildProcess.execFileSync(
              "git",
              ["worktree", "add", "-b", "feature", path + "/target"],
              {
                cwd: path,
                stdio: "ignore",
              },
            );
            NodeFS.mkdirSync(path + "/subdirectory");
            NodeChildProcess.execFileSync("git", ["init", path + "/unrelated"], {
              stdio: "ignore",
            });
            return path;
          }),
          (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
        );
        let thread: OrchestrationThreadShell = {
          id: threadId,
          projectId,
          title: "Thread",
          modelSelection: { instanceId, model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "dev",
          worktreePath: null,
          pullRequests: [],
          latestTurn: {
            turnId,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: instanceId,
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
          latestUserMessageAt: now,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        };
        const commands: OrchestrationCommand[] = [];
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: (id) =>
              Effect.sync(() => (id === threadId ? Option.some(thread) : Option.none())),
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: projectId,
                  title: "Project",
                  workspaceRoot: root,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: now,
                  updatedAt: now,
                }),
              ),
          }),
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                if (command.type === "thread.worktree-switch.schedule")
                  thread = {
                    ...thread,
                    worktreeSwitch: {
                      requestId: command.commandId,
                      turnId,
                      sourceWorktreePath: null,
                      sourceBranch: "dev",
                      targetPath: command.targetPath,
                      requestedAt: now,
                      status: "pending",
                    },
                  };
                if (command.type === "thread.worktree-switch.cancel" && thread.worktreeSwitch)
                  thread = {
                    ...thread,
                    worktreeSwitch: { ...thread.worktreeSwitch, status: "cancelled" },
                  };
                return { sequence: commands.length };
              }),
          }),
        );
        yield* Effect.gen(function* () {
          const toolkit = yield* WorktreeToolkit.pipe(Effect.provide(WorktreeToolkitHandlersLive));
          const path =
            scenario === "root"
              ? root
              : scenario === "relative"
                ? "target"
                : scenario === "worktree" || scenario === "wrong-provider"
                  ? root + "/target"
                  : root + "/" + scenario;
          const result = yield* toolkit
            .handle("switch_worktree", { path })
            .pipe(Stream.unwrap, Stream.runCollect, Effect.result);
          if (scenario === "worktree" || scenario === "root") {
            expect(result._tag).toBe("Success");
            expect(commands).toMatchObject([
              { type: "thread.worktree-switch.schedule", threadId, turnId, targetPath: path },
            ]);
            expect(thread.worktreePath).toBeNull();
            const status = yield* toolkit
              .handle("worktree_switch_status", {})
              .pipe(Stream.unwrap, Stream.runCollect);
            expect(status.at(-1)?.result).toMatchObject({
              request: { status: "pending", targetPath: path },
            });
            yield* toolkit
              .handle("cancel_worktree_switch", {})
              .pipe(Stream.unwrap, Stream.runDrain);
            expect(thread.worktreeSwitch?.status).toBe("cancelled");
          } else {
            expect(result._tag).toBe("Failure");
            expect(commands).toEqual([]);
          }
        }).pipe(
          Effect.provide(dependencies),
          Effect.provideService(McpInvocationContext, {
            threadId,
            environmentId: EnvironmentId.make("env"),
            providerSessionId: "session",
            providerInstanceId:
              scenario === "wrong-provider" ? ProviderInstanceId.make("other") : instanceId,
            capabilities: new Set<never>(),
            issuedAt: 1,
          }),
        );
      }),
    ),
);
