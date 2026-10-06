import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "./worktreesDirectory.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import {
  canonicalWorkspacePath,
  reserveWorkspace,
  withWorkspaceLease,
} from "./workspace/workspaceLease.ts";

const decodeCleanupThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeCleanupSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

const DAY_MS = 86_400_000;

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

function sameProjectWorktreePolicies(left: ServerSettings, right: ServerSettings): boolean {
  return [
    ...new Set([
      ...Object.keys(left.projectSettingsOverrides),
      ...Object.keys(right.projectSettingsOverrides),
    ]),
  ].every((projectId) =>
    Equal.equals(
      left.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
      right.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
    ),
  );
}

/** Live sessions keep their cwd even when no turn is currently running. */
export function storageCleanupThreadIdle(thread: OrchestrationV2ThreadShell, now: number): boolean {
  return (
    thread.branch !== null &&
    thread.worktreePath !== null &&
    thread.activeRunId === null &&
    (thread.status === "idle" || thread.status === "failed") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    !threadHasQueuedTurnStart(thread, now)
  );
}

/** PR metadata refreshes must not reset the inactivity clock. */
export function storageCleanupActivityAt(thread: OrchestrationV2ThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].flatMap((value) => (value == null ? [] : [DateTime.toEpochMillis(value)])),
  );
}

/**
 * Fork: whether anything other than `candidateId` still uses the canonical
 * `worktreePath`: another thread's checkout (through an alias or a nested
 * path), a pending archive or worktree move into or out of it, or a live
 * provider session cwd. A deleted thread passes a null `candidateId`.
 */
export const storageCleanupWorktreeInUse = Effect.fn("storageCleanupWorktreeInUse")(
  function* (input: {
    readonly worktreePath: string;
    readonly candidateId: OrchestrationV2ThreadShell["id"] | null;
    readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
    readonly sessionCwds: ReadonlyArray<string>;
  }) {
    const path = yield* Path.Path;
    const uses = (cwd: string | null | undefined) =>
      cwd == null
        ? Effect.succeed(false)
        : canonicalWorkspacePath(cwd).pipe(
            Effect.map((canonical) => {
              const relative = path.relative(input.worktreePath, canonical);
              return (
                relative === "" ||
                (relative !== ".." &&
                  !relative.startsWith(`..${path.sep}`) &&
                  !path.isAbsolute(relative))
              );
            }),
          );
    for (const thread of input.threads) {
      if (thread.id !== input.candidateId && (yield* uses(thread.worktreePath))) return true;
      if (thread.archiveRequest?.status === "pending" && (yield* uses(thread.worktreePath)))
        return true;
      const move = thread.worktreeSwitch;
      if (
        move?.status === "pending" &&
        ((yield* uses(move.targetPath)) || (yield* uses(move.sourceWorktreePath)))
      )
        return true;
    }
    for (const cwd of input.sessionCwds) if (yield* uses(cwd)) return true;
    return false;
  },
);

/**
 * Fork: cwds of provider sessions that are not stopped, for
 * `storageCleanupWorktreeInUse`. Sessions can outlive their run and can be
 * shared across app threads.
 */
export const readLiveProviderSessionCwds = Effect.fn("readLiveProviderSessionCwds")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_provider_sessions
    WHERE status != 'stopped'
  `;
  return (yield* Effect.forEach(rows, (row) => decodeCleanupSession(row.payload_json))).map(
    (session) => session.cwd,
  );
});

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const hasTerminal = Effect.fn("StorageCleanup.hasTerminal")(function* (worktreePath: string) {
    for (const terminal of [...liveTerminals.values()].flatMap((entries) => [
      ...entries.values(),
    ])) {
      if (terminal.status !== "starting" && terminal.status !== "running") continue;
      const cwd = yield* canonicalWorkspacePath(terminal.cwd);
      if (
        cwd === worktreePath ||
        inside(worktreePath, cwd) ||
        (terminal.worktreePath !== null &&
          (yield* canonicalWorkspacePath(terminal.worktreePath)) === worktreePath)
      )
        return true;
    }
    return false;
  });

  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const active = yield* projections.getShellSnapshot();
    const archived = yield* projections.getShellSnapshot({ location: "archive" });
    const projects = yield* projectStore.listShells();
    return { projects, threads: [...active.threads, ...archived.threads] };
  });

  const readLiveSessionCwds = () =>
    readLiveProviderSessionCwds().pipe(Effect.provideService(SqlClient.SqlClient, sql));

  // Local threads under another project need not have a worktreePath of their own.
  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    for (const project of projects) {
      const projectPath = path.resolve(project.workspaceRoot);
      if (projectPath === worktreePath || inside(worktreePath, projectPath)) return true;
      const realPath = yield* canonicalWorkspacePath(project.workspaceRoot);
      if (realPath === worktreePath || inside(worktreePath, realPath)) return true;
    }
    return false;
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
  ) {
    if (!anyWorktreePolicy(serverSettings, worktreeCleanupEnabled)) return;
    const roots: Array<string> = [];
    for (const directory of managedWorktreesDirectories(
      serverSettings,
      config.worktreesDir,
      path,
    )) {
      // An unmounted drive only skips its own worktrees.
      const root = yield* fs.exists(directory).pipe(
        Effect.flatMap((exists) => (exists ? fs.realPath(directory) : Effect.succeed(null))),
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && !isFilesystemRoot(root, path)) roots.push(root);
    }
    if (roots.length === 0) return;
    const hasDeleteRule = anyWorktreePolicy(serverSettings, (rules) => rules.worktreeOnDelete);
    const deletedRows = hasDeleteRule
      ? yield* sql<{ payload_json: string; workspaceRoot: string }>`
          SELECT t.payload_json, p.workspace_root AS "workspaceRoot"
          FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.deleted_at IS NOT NULL
        `
      : [];
    const deletedThreads = (yield* Effect.forEach(deletedRows, (row) =>
      decodeCleanupThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, workspaceRoot: row.workspaceRoot })),
      ),
    )).filter(
      (thread) =>
        thread.worktreePath !== null &&
        thread.branch !== null &&
        resolveWorktreeCleanup(serverSettings, thread.projectId).worktreeOnDelete,
    );
    const snapshot = yield* readThreads();
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    // Aliases of one checkout are one owner group.
    const groups = new Map<string, OrchestrationV2ThreadShell[]>();
    for (const thread of snapshot.threads) {
      if (thread.worktreePath === null) continue;
      const key = yield* canonicalWorkspacePath(thread.worktreePath);
      groups.set(key, [...(groups.get(key) ?? []), thread]);
    }
    const candidates = [
      ...[...groups.values()].flatMap((group) => (group.length === 1 ? [group[0]!] : [])),
      ...(yield* Effect.filter(deletedThreads, (thread) =>
        canonicalWorkspacePath(thread.worktreePath!).pipe(Effect.map((key) => !groups.has(key))),
      )),
    ];
    const sessionCwds = yield* readLiveSessionCwds();
    // Owners are already grouped by canonical path; keep this pre-check to the
    // few threads with a pending archive or move.
    const pendingThreads = snapshot.threads.filter(
      (entry) =>
        entry.archiveRequest?.status === "pending" || entry.worktreeSwitch?.status === "pending",
    );
    for (const thread of candidates) {
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      // Validate the recorded path itself first: a symlinked parent (a linked
      // drive) is fine, a symlinked worktree directory is not. Every later
      // check (owners, terminals, sessions, roots, reservations, revalidation)
      // then uses the canonical path, so an alias cannot slip past them.
      const recordedPath = path.resolve(thread.worktreePath!);
      const worktreePath = yield* Effect.gen(function* () {
        if (!(yield* fs.exists(recordedPath))) return null;
        const realPath = yield* fs.realPath(recordedPath);
        const realParent = yield* fs.realPath(path.dirname(recordedPath));
        return realPath === path.join(realParent, path.basename(recordedPath)) ? realPath : null;
      }).pipe(Effect.orElseSucceed(() => null));
      if (worktreePath === null) continue;
      const deleted = "workspaceRoot" in thread;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      if (
        project === undefined ||
        (!deleted && !storageCleanupThreadIdle(thread, now)) ||
        (yield* hasTerminal(worktreePath)) ||
        (yield* storageCleanupWorktreeInUse({
          worktreePath,
          candidateId: deleted ? null : thread.id,
          threads: pendingThreads,
          sessionCwds,
        }))
      )
        continue;
      yield* Effect.gen(function* () {
        // Roots are canonical, like `worktreePath`.
        if (!roots.some((root) => inside(root, worktreePath))) return;
        if (yield* containsProjectRoot(worktreePath, [project, ...snapshot.projects])) return;
        // A linked worktree has a .git file. Never remove a main checkout.
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File") return;
        const status = yield* git.statusDetailsLocal(worktreePath);
        if (!status.isRepo || status.branch !== thread.branch || status.hasWorkingTreeChanges)
          return;
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        const ignored = yield* git.execute({
          operation: "StorageCleanup.ignoredFiles",
          cwd: worktreePath,
          args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
          maxOutputBytes: 64 * 1024,
        });
        // Ignored files can contain secrets or local datasets. Dependency installs
        // are reproducible; every other ignored path prevents automatic removal.
        if (
          ignored.stdoutTruncated ||
          ignored.stdout
            .split("\0")
            .some((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry))
        )
          return;
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          storageCleanupActivityAt(thread) < now - settings.worktreeAfterDays * DAY_MS;
        let eligible = deleted || old;
        if (!eligible && (settings.worktreeUnchanged || settings.worktreeOnMerge)) {
          const repositoryCwd = path.resolve(project.workspaceRoot);
          const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
          const branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
          if (branch === null) return;
          const defaultRef = `refs/remotes/${remote}/${branch}`;
          const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
          if (!refreshed.has(defaultRef)) {
            yield* git.fetchRemoteTrackingBranch({
              cwd: repositoryCwd,
              remoteName: remote,
              remoteBranch: branch,
            });
            refreshed.add(defaultRef);
            refreshedDefaultRefs.set(repositoryCwd, refreshed);
          }
          const base = yield* git.resolveCommit({
            cwd: worktreePath,
            revision: defaultRef,
          });
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.integratedBranch",
            cwd: worktreePath,
            args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
            allowNonZeroExit: true,
          });
          if (ancestor.exitCode !== 0) return;
          eligible = settings.worktreeUnchanged;
          if (!eligible && settings.worktreeOnMerge && thread.branch !== null) {
            const pullRequest = yield* gitManager.branchPullRequest(
              { cwd: worktreePath, branch: thread.branch },
              { refresh: true },
            );
            eligible = pullRequest?.state === "merged";
          }
        }
        if (!eligible) return;
        // Re-read after Git/host calls so a queued turn, resumed session, new
        // owner or pending move cancels the removal. The last check runs under a
        // removal reservation, right before Git removes the checkout.
        const stillUnused = Effect.fn("StorageCleanup.stillUnused")(function* () {
          const latestSnapshot = yield* readThreads();
          if (yield* containsProjectRoot(worktreePath, [project, ...latestSnapshot.projects]))
            return false;
          if (yield* hasTerminal(worktreePath)) return false;
          if (
            yield* storageCleanupWorktreeInUse({
              worktreePath,
              candidateId: deleted ? null : thread.id,
              threads: latestSnapshot.threads,
              sessionCwds: yield* readLiveSessionCwds(),
            })
          )
            return false;
          if (deleted) {
            if (
              !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
                .worktreeOnDelete
            )
              return false;
            // V2 deletion queues durable cleanup. Do not remove its checkout until
            // every effect has finished successfully or was explicitly cancelled.
            const pendingCleanup = yield* sql`
              SELECT 1 FROM orchestration_v2_effect_outbox
              WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
            `;
            return pendingCleanup.length === 0;
          }
          const latest = latestSnapshot.threads.find((entry) => entry.id === thread.id);
          return (
            latest !== undefined &&
            latest.worktreePath !== null &&
            (yield* canonicalWorkspacePath(latest.worktreePath)) === worktreePath &&
            storageCleanupThreadIdle(latest, now) &&
            storageCleanupActivityAt(latest) === storageCleanupActivityAt(thread)
          );
        });
        if (!(yield* stillUnused())) return;
        const finalStatus = yield* git.statusDetailsLocal(worktreePath);
        if (
          !finalStatus.isRepo ||
          finalStatus.branch !== thread.branch ||
          finalStatus.hasWorkingTreeChanges
        )
          return;
        if (
          (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
          head.commitSha
        )
          return;
        const finalIgnored = yield* git.execute({
          operation: "StorageCleanup.ignoredFiles",
          cwd: worktreePath,
          args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
          maxOutputBytes: 64 * 1024,
        });
        if (
          finalIgnored.stdoutTruncated ||
          finalIgnored.stdout
            .split("\0")
            .some((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry))
        )
          return;
        const current = resolveWorktreeCleanup(
          yield* settingsService.getSettings,
          thread.projectId,
        );
        if (
          Object.keys(settings).some(
            (key) =>
              current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
          )
        )
          return;
        yield* Effect.gen(function* () {
          if (!(yield* reserveWorkspace(worktreePath, "removal")) || !(yield* stillUnused()))
            return;
          yield* git.removeWorktree({
            cwd: project.workspaceRoot,
            path: worktreePath,
            force: false,
          });
          yield* gitManager.invalidateStatus(project.workspaceRoot);
          // Preserve branch and path: ProviderTurnStartService recreates the checkout
          // from that branch when the thread is resumed.
          yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
        }).pipe(Effect.scoped);
      }).pipe(
        (effect) => withWorkspaceLease(worktreePath, effect),
        Effect.catch((error) =>
          Effect.logDebug("storage cleanup skipped worktree", { threadId: thread.id, error }),
        ),
      );
    }
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
  ) {
    if (days === null || !(yield* fs.exists(root))) return;
    const realRoot = yield* fs.realPath(root);
    if (realRoot !== path.resolve(root)) return;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory" && rotatedLogs) {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            yield* fs.remove(target);
          }
        }
      }
    });
    yield* visit(realRoot);
  });

  const sweep = Effect.fn("StorageCleanup.sweep")(function* () {
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const now = yield* Clock.currentTimeMillis;
    yield* cleanWorktrees(serverSettings, now).pipe(
      Effect.catch((error) => Effect.logWarning("worktree cleanup failed", { error })),
    );
    yield* cleanFiles(
      config.browserArtifactsDir,
      settings.browserArtifactsAfterDays,
      now,
      false,
    ).pipe(
      Effect.catch((error) => Effect.logWarning("browser artifact cleanup failed", { error })),
    );
    yield* cleanFiles(config.logsDir, settings.logsAfterDays, now, true).pipe(
      Effect.catch((error) => Effect.logWarning("rotated log cleanup failed", { error })),
    );
  });
  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("storage cleanup failed", { cause }),
      ),
    ),
  );

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          liveTerminals.clear();
          for (const terminal of event.terminals) noteTerminal(terminal);
        } else if (event.type === "upsert") {
          noteTerminal(event.terminal);
        } else {
          const threadTerminals = liveTerminals.get(event.threadId);
          threadTerminals?.delete(event.terminalId);
          if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const events = engine.streamDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      worker
        .enqueue(undefined)
        .pipe(
          Effect.andThen(worker.drain),
          Effect.repeat(Schedule.spaced("1 hour")),
          Effect.asVoid,
        ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup) &&
          sameProjectWorktreePolicies(settings, lastSettings)
        )
          return Effect.void;
        lastSettings = settings;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        (event.type === "thread.deleted" || event.type === "provider-session.updated") &&
        anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)
          ? worker.enqueue(undefined)
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Storage cleanup event stream failed", { cause }),
        ),
      ),
    );
  });
  return { start, drain: worker.drain };
});
