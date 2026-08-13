#!/usr/bin/env node

/**
 * Answers "why does this thread still say Working/Monitoring, and what is it?"
 *
 * The sidebar pill reads ThreadBackgroundLivenessService, an in-memory registry
 * holding bare task ids — it can say *that* background work is live but never
 * *what*, and nothing exposes it over RPC. This script reconstructs the same
 * answer offline by replaying the persisted `task.*` activity rows through the
 * real registry (imported, not reimplemented, so classification cannot drift),
 * then names each surviving task and hunts down the OS process behind it.
 *
 * Replay is an approximation of the registry in two knowable directions, both
 * reported rather than hidden:
 *   - the registry is cleared when a provider session dies, and a server
 *     restart empties it entirely; replay cannot see either, so it can list a
 *     task the pill has already forgotten. The process probe is what settles
 *     it — a task with no live process is orphaned, not working.
 *   - activity rows age out under retention. A task whose start row is gone and
 *     whose terminal row never arrived is invisible here (false negative).
 *
 * Run it against the current thread inside any T3 terminal (T3CODE_THREAD_ID is
 * set for every session), or with --all to sweep the whole server:
 *
 *   node apps/server/scripts/t3-thread-background.ts
 *   node apps/server/scripts/t3-thread-background.ts --all --json
 */

// @effect-diagnostics nodeBuiltinImport:off - node:os and node:child_process back the shared-home default and the process probe.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Command, Flag } from "effect/unstable/cli";

import {
  make as makeThreadBackgroundLiveness,
  type ThreadBackgroundLiveness,
} from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";

export class ThreadBackgroundDatabaseMissingError extends Schema.TaggedErrorClass<ThreadBackgroundDatabaseMissingError>()(
  "ThreadBackgroundDatabaseMissingError",
  { databasePath: Schema.String },
) {
  override get message(): string {
    return `Database does not exist at '${this.databasePath}'. Start T3 once to run migrations.`;
  }
}

export class ThreadBackgroundMissingThreadError extends Schema.TaggedErrorClass<ThreadBackgroundMissingThreadError>()(
  "ThreadBackgroundMissingThreadError",
  {},
) {
  override get message(): string {
    return "No thread selected. Pass --thread <id>, use --all, or run inside a T3 terminal (which sets T3CODE_THREAD_ID).";
  }
}

export class ThreadBackgroundDatabaseError extends Schema.TaggedErrorClass<ThreadBackgroundDatabaseError>()(
  "ThreadBackgroundDatabaseError",
  { databasePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to read '${this.databasePath}'.`;
  }
}

/** Activity rows are internal projection data; every field is read defensively. */
interface TaskActivityRow {
  readonly thread_id: string;
  readonly kind: string;
  readonly created_at: string;
  readonly payload_json: string;
}

interface TaskPayload {
  readonly taskId?: unknown;
  readonly taskType?: unknown;
  readonly status?: unknown;
  readonly agentId?: unknown;
  readonly title?: unknown;
  readonly detail?: unknown;
  readonly isBackgrounded?: unknown;
}

export interface LiveTask {
  readonly threadId: string;
  readonly taskId: string;
  readonly taskType: string | null;
  readonly title: string | null;
  readonly liveness: Exclude<ThreadBackgroundLiveness, null>;
  readonly startedAt: string | null;
  readonly lastEventAt: string;
  readonly backgrounded: boolean;
}

export interface ThreadReport {
  readonly threadId: string;
  readonly title: string;
  readonly liveness: ThreadBackgroundLiveness;
  readonly tasks: ReadonlyArray<LiveTask>;
  readonly session: SessionProbe | null;
}

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly elapsed: string;
  readonly cpuTime: string;
  readonly command: string;
}

export interface SessionProbe {
  readonly resumeId: string | null;
  readonly providerPid: number | null;
  readonly children: ReadonlyArray<ProcessInfo>;
  /** Reported rather than dropped silently: the filter can hide a real culprit. */
  readonly hiddenMcpChildren: number;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

function parseTaskPayload(raw: string): TaskPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as TaskPayload) : null;
  } catch {
    return null;
  }
}

/** `task.started` → `started`, matching ProviderRuntimeIngestion's own mapping. */
function livenessKind(
  activityKind: string,
): "started" | "progress" | "updated" | "completed" | null {
  switch (activityKind) {
    case "task.started":
      return "started";
    case "task.progress":
      return "progress";
    case "task.updated":
      return "updated";
    case "task.completed":
      return "completed";
    default:
      return null;
  }
}

interface TaskTrace {
  readonly threadId: string;
  readonly taskId: string;
  taskType: string | null;
  title: string | null;
  startedAt: string | null;
  lastEventAt: string;
  backgrounded: boolean;
  readonly events: Array<{
    readonly kind: "started" | "progress" | "updated" | "completed";
    readonly taskType: string | undefined;
    readonly status: string | undefined;
    readonly agentId: string | undefined;
  }>;
}

/**
 * Replay each task's own events into a fresh registry keyed by its thread.
 * The registry buckets tasks independently and only folds them at read time,
 * so a per-task replay yields exactly the bucket a whole-thread replay would —
 * and `getThreadBackgroundLiveness` doubles as the agent-vs-monitor verdict.
 */
function classifyTask(trace: TaskTrace): Exclude<ThreadBackgroundLiveness, null> | null {
  const registry = makeThreadBackgroundLiveness();
  for (const event of trace.events) {
    registry.recordTaskLiveness({
      threadId: trace.threadId,
      taskId: trace.taskId,
      kind: event.kind,
      taskType: event.taskType,
      status: event.status,
      agentId: event.agentId,
    });
  }
  return registry.getThreadBackgroundLiveness(trace.threadId);
}

export function collectLiveTasks(rows: ReadonlyArray<TaskActivityRow>): ReadonlyArray<LiveTask> {
  const traces = new Map<string, TaskTrace>();

  for (const row of rows) {
    const kind = livenessKind(row.kind);
    if (kind === null) continue;
    const payload = parseTaskPayload(row.payload_json);
    if (payload === null) continue;
    const taskId = asString(payload.taskId);
    if (taskId === null) continue;

    const traceKey = `${row.thread_id} ${taskId}`;
    const taskType = asString(payload.taskType);
    const existing = traces.get(traceKey);
    const trace: TaskTrace = existing ?? {
      threadId: row.thread_id,
      taskId,
      taskType: null,
      title: null,
      startedAt: null,
      lastEventAt: row.created_at,
      backgrounded: false,
      events: [],
    };
    if (!existing) traces.set(traceKey, trace);

    // Later rows carry the fuller picture; earlier non-null values are kept
    // when a later row omits the field.
    trace.taskType = taskType ?? trace.taskType;
    trace.title = asString(payload.title) ?? asString(payload.detail) ?? trace.title;
    trace.lastEventAt = row.created_at;
    if (kind === "started" && trace.startedAt === null) trace.startedAt = row.created_at;
    if (payload.isBackgrounded === true) trace.backgrounded = true;
    trace.events.push({
      kind,
      taskType: taskType ?? undefined,
      status: asString(payload.status) ?? undefined,
      agentId: asString(payload.agentId) ?? undefined,
    });
  }

  const live: LiveTask[] = [];
  for (const trace of traces.values()) {
    const liveness = classifyTask(trace);
    if (liveness === null) continue;
    live.push({
      threadId: trace.threadId,
      taskId: trace.taskId,
      taskType: trace.taskType,
      title: trace.title,
      liveness,
      startedAt: trace.startedAt,
      lastEventAt: trace.lastEventAt,
      backgrounded: trace.backgrounded,
    });
  }
  return live.toSorted((left, right) => left.lastEventAt.localeCompare(right.lastEventAt));
}

export function foldLiveness(tasks: ReadonlyArray<LiveTask>): ThreadBackgroundLiveness {
  if (tasks.some((task) => task.liveness === "working")) return "working";
  if (tasks.some((task) => task.liveness === "monitoring")) return "monitoring";
  return null;
}

function resumeIdFromCursor(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return asString((parsed as { resume?: unknown }).resume);
  } catch {
    return null;
  }
}

/**
 * MCP servers are spawned per provider session and are never the stuck work;
 * listing them would bury the one process that matters.
 */
const MCP_CHILD_PATTERN = /\bmcp\b/i;

function listProcesses(platform: NodeJS.Platform): ReadonlyArray<ProcessInfo> {
  // `ps` has no usable Windows equivalent here; the report degrades to the
  // task list rather than guessing at processes.
  if (platform === "win32") return [];
  try {
    // `-ww` asks for the untruncated command line on both BSD and GNU `ps`.
    // Provider command lines are long and the `--resume=` argument sits at the
    // end, so a width-truncated listing would silently match nothing.
    const output = NodeChildProcess.execFileSync(
      "ps",
      ["-Awwo", "pid=,ppid=,etime=,time=,command="],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const processes: ProcessInfo[] = [];
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const [, pid, ppid, elapsed, cpuTime, command] = match;
      if (!pid || !ppid || !elapsed || !cpuTime || command === undefined) continue;
      processes.push({
        pid: Number(pid),
        ppid: Number(ppid),
        elapsed,
        cpuTime,
        command,
      });
    }
    return processes;
  } catch {
    return [];
  }
}

/**
 * The provider process is found by its `--resume=<sessionId>` argument, the
 * only durable link between a thread's persisted runtime row and a live pid.
 */
export function probeSession(resumeId: string | null, platform: NodeJS.Platform): SessionProbe {
  const empty = { resumeId, providerPid: null, children: [], hiddenMcpChildren: 0 } as const;
  if (resumeId === null) return empty;
  const processes = listProcesses(platform);
  const provider = processes.find((candidate) => candidate.command.includes(`resume=${resumeId}`));
  if (!provider) return empty;

  const byParent = new Map<number, ProcessInfo[]>();
  for (const candidate of processes) {
    const siblings = byParent.get(candidate.ppid);
    if (siblings) siblings.push(candidate);
    else byParent.set(candidate.ppid, [candidate]);
  }

  const children: ProcessInfo[] = [];
  let hiddenMcpChildren = 0;
  const walk = (pid: number) => {
    for (const child of byParent.get(pid) ?? []) {
      if (MCP_CHILD_PATTERN.test(child.command)) hiddenMcpChildren += 1;
      else children.push(child);
      walk(child.pid);
    }
  };
  walk(provider.pid);
  return { resumeId, providerPid: provider.pid, children, hiddenMcpChildren };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function formatReports(reports: ReadonlyArray<ThreadReport>): string {
  const live = reports.filter((report) => report.liveness !== null);
  if (live.length === 0) {
    return "No live background work.";
  }

  const lines: string[] = [];
  for (const report of live) {
    lines.push(`${report.liveness?.toUpperCase()}  ${report.title}`);
    lines.push(`  thread ${report.threadId}`);
    for (const task of report.tasks) {
      const type = task.taskType ?? "unknown type";
      lines.push(`  • [${task.liveness}] ${task.title ?? task.taskId} (${type})`);
      lines.push(
        `      task ${task.taskId} · started ${task.startedAt ?? "unknown"} · last event ${task.lastEventAt}${
          task.backgrounded ? " · backgrounded" : ""
        }`,
      );
    }
    const session = report.session;
    if (session === null || session.resumeId === null) {
      lines.push("  no provider session recorded — the work is orphaned, not live");
    } else if (session.providerPid === null) {
      lines.push(
        `  provider session ${session.resumeId} is not running — the work is orphaned, not live`,
      );
    } else {
      const hidden =
        session.hiddenMcpChildren === 0
          ? ""
          : ` (${session.hiddenMcpChildren} MCP server${session.hiddenMcpChildren === 1 ? "" : "s"} not shown)`;
      if (session.children.length === 0) {
        lines.push(`  provider pid ${session.providerPid} · no other child processes${hidden}`);
      } else {
        lines.push(`  provider pid ${session.providerPid} · live child processes${hidden}:`);
        for (const child of session.children) {
          lines.push(
            `      pid ${child.pid} · up ${child.elapsed} · cpu ${child.cpuTime} · ${truncate(child.command, 140)}`,
          );
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export interface RunThreadBackgroundInput {
  readonly baseDir: string | undefined;
  readonly threadId: string | undefined;
  readonly all: boolean;
}

export const runThreadBackground = Effect.fn("runThreadBackground")(function* (
  input: RunThreadBackgroundInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const baseDir = path.resolve(input.baseDir ?? path.join(NodeOS.homedir(), ".t3"));
  const databasePath = path.join(baseDir, "userdata", "state.sqlite");

  // Every T3 terminal exports T3CODE_THREAD_ID, so an action can run this with
  // no arguments at all.
  const threadId = (input.threadId ?? environment.T3CODE_THREAD_ID)?.trim() || undefined;

  if (!input.all && threadId === undefined) {
    return yield* new ThreadBackgroundMissingThreadError();
  }
  if (!(yield* fs.exists(databasePath))) {
    return yield* new ThreadBackgroundDatabaseMissingError({ databasePath });
  }

  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 5000").unprepared;

    const activityRows = input.all
      ? yield* sql<TaskActivityRow>`
          select thread_id, kind, created_at, payload_json
          from projection_thread_activities
          where kind like 'task.%'
          order by created_at`
      : yield* sql<TaskActivityRow>`
          select thread_id, kind, created_at, payload_json
          from projection_thread_activities
          where thread_id = ${threadId ?? ""} and kind like 'task.%'
          order by created_at`;

    const tasks = collectLiveTasks(activityRows);
    const threadIds = input.all
      ? Array.from(new Set(tasks.map((task) => task.threadId)))
      : threadId === undefined
        ? []
        : [threadId];
    if (threadIds.length === 0) {
      return [] as ReadonlyArray<ThreadReport>;
    }

    const titleRows = yield* sql<{ thread_id: string; title: string }>`
      select thread_id, title from projection_threads
      where ${sql.in("thread_id", threadIds)}`;
    const cursorRows = yield* sql<{ thread_id: string; resume_cursor_json: string | null }>`
      select thread_id, resume_cursor_json from provider_session_runtime
      where ${sql.in("thread_id", threadIds)}`;

    const titles = new Map(titleRows.map((row) => [row.thread_id, row.title]));
    const cursors = new Map(cursorRows.map((row) => [row.thread_id, row.resume_cursor_json]));

    return threadIds.map((id): ThreadReport => {
      const threadTasks = tasks.filter((task) => task.threadId === id);
      const liveness = foldLiveness(threadTasks);
      return {
        threadId: id,
        title: titles.get(id) ?? "(unknown thread)",
        liveness,
        tasks: threadTasks,
        session:
          liveness === null
            ? null
            : probeSession(resumeIdFromCursor(cursors.get(id) ?? null), platform),
      };
    });
  });

  return yield* program.pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })),
    Effect.mapError((cause) => new ThreadBackgroundDatabaseError({ databasePath, cause })),
  );
});

export const t3ThreadBackgroundCommand = Command.make(
  "t3-thread-background",
  {
    thread: Flag.string("thread").pipe(
      Flag.optional,
      Flag.withDescription("Thread id to inspect. Defaults to $T3CODE_THREAD_ID."),
    ),
    baseDir: Flag.string("base-dir").pipe(
      Flag.optional,
      Flag.withDescription(
        "T3 base directory containing userdata/state.sqlite. Defaults to ~/.t3.",
      ),
    ),
    all: Flag.boolean("all").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Sweep every thread with live background work."),
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Emit the report as JSON."),
    ),
  },
  ({ thread, baseDir, all, json }) =>
    runThreadBackground({
      baseDir: Option.getOrUndefined(baseDir),
      threadId: Option.getOrUndefined(thread),
      all,
    }).pipe(
      Effect.flatMap((reports) =>
        Console.log(json ? JSON.stringify({ threads: reports }, null, 2) : formatReports(reports)),
      ),
    ),
).pipe(
  Command.withDescription(
    "Show which background tasks are keeping a thread marked Working or Monitoring, and the processes behind them.",
  ),
);

if (import.meta.main) {
  Command.run(t3ThreadBackgroundCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
