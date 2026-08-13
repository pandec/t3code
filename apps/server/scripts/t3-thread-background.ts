#!/usr/bin/env node

/**
 * Answers "why does this thread still say Working/Monitoring, and what is it?"
 *
 * The sidebar pill reads ThreadBackgroundLivenessService, an in-memory registry
 * holding bare task ids — it can say *that* background work is live but never
 * *what*, and nothing exposes it over RPC. This script reconstructs the same
 * answer offline by replaying the persisted `task.*` activity rows through the
 * real registry — imported, so it shares the pill's classifier rather than
 * restating it — then names each surviving task and hunts down the OS process
 * behind it. The classifier is shared; the feed into it is not, so
 * `livenessKind` and the payload extraction below still have to be kept in step
 * with ProviderRuntimeIngestion by hand.
 *
 * Replay is not the registry, and the gap runs one way. Activity rows are
 * never pruned (the only delete is per-thread, on thread removal), while the
 * registry is emptied by a server restart and cleared when a provider session
 * dies. So every task whose terminal row never arrived — a SIGKILLed server, a
 * crashed provider, a lost `task.completed` — replays as live forever, long
 * after the pill has forgotten it. That direction dominates: replay tends to
 * report more than the pill, not less.
 *
 * The process probe is what settles it, and its verdict is the headline: work
 * whose provider process is gone reports as ORPHANED, not as live. When the
 * probe cannot run at all — a Codex session, which is not addressable by
 * command line, or a host without `ps` — the report says UNKNOWN rather than
 * guessing in either direction.
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
import * as NodeProcess from "node:process";
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
  /** What replay alone concluded — the same value the sidebar pill shows. */
  readonly liveness: ThreadBackgroundLiveness;
  /**
   * What replay and the process probe conclude together, and the only field
   * worth acting on. `orphaned` means the tasks below are bookkeeping left
   * behind by a dead session; `unknown` means the probe could not run.
   */
  readonly verdict: "live" | "orphaned" | "unknown" | "idle";
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

export type ProbeOutcome =
  /** The provider process was found; `children` is its live descendant list. */
  | "found"
  /** Addressable, looked for, absent — the work behind it is orphaned. */
  | "not-running"
  /** Not addressable by process at all; the probe declines to guess. */
  | "unsupported";

export interface SessionProbe {
  readonly outcome: ProbeOutcome;
  /** Why the probe could not run. Set only when `outcome` is "unsupported". */
  readonly unsupportedReason: string | null;
  readonly resumeId: string | null;
  readonly providerPid: number | null;
  readonly children: ReadonlyArray<ProcessInfo>;
  /**
   * Reported rather than dropped silently: the filter matches any command
   * containing "mcp", which is broader than "is an MCP server".
   */
  readonly hiddenChildren: number;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/**
 * `task.started` → `started`, matching ProviderRuntimeIngestion's own mapping.
 *
 * Usage-snapshot rows are deliberately NOT filtered out here. They look inert —
 * ingestion strips `status` from them — but the registry is fed from the
 * underlying runtime event, which it records as a status-less progress that
 * drops and re-adds the task. When `typedUsage` is the only state on the event,
 * the usage row is the *only* row persisted, so skipping it would hide a task
 * the pill is still showing. Replaying it keeps the two in step; they retain
 * `taskType` and `agentId`, so classification is unaffected.
 */
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
    // Persistence records both true and false; treating it as sticky would
    // keep labelling a foregrounded task "backgrounded".
    if (typeof payload.isBackgrounded === "boolean") trace.backgrounded = payload.isBackgrounded;
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

/**
 * Ask the registry for the fold too, rather than restating its
 * agents-beat-monitors precedence here.
 */
export function foldLiveness(tasks: ReadonlyArray<LiveTask>): ThreadBackgroundLiveness {
  const registry = makeThreadBackgroundLiveness();
  const threadId = "fold";
  for (const task of tasks) {
    registry.recordTaskLiveness({
      threadId,
      taskId: task.taskId,
      kind: "started",
      taskType: task.liveness === "monitoring" ? "local_bash" : undefined,
      status: undefined,
      agentId: undefined,
    });
  }
  return registry.getThreadBackgroundLiveness(threadId);
}

/**
 * The provider's own session identifier, when it is one the OS can be asked
 * about. Only the Claude driver puts its session id on the command line
 * (`--resume=<id>`); a Codex cursor carries `threadId`/`strictResume`, which
 * never appear in argv because Codex identifies its session over stdio. So a
 * missing `resume` key is "cannot probe", never "nothing is running".
 */
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
 * Hides the MCP servers every provider session spawns, which would otherwise
 * bury the one process that matters. Deliberately a substring match, so it can
 * also catch a nested provider CLI carrying `--mcp-config`; the count of what
 * it swallowed is reported, and `--show-all-children` turns it off.
 */
const MCP_CHILD_PATTERN = /\bmcp\b/i;

/**
 * Command lines are printed, and agent-run commands carry credentials — T3's
 * own provider subprocesses embed an MCP bearer token in `--mcp-config`. The
 * report is meant to be pasted into issues and read by agents, so secrets are
 * blanked on the way out rather than trusted to a truncation limit.
 */
export function redactCommand(command: string): string {
  return command
    .replace(/(--mcp-config[= ]).*/gi, "$1<redacted>")
    .replace(/((?:authorization|bearer)\s+)\S+/gi, "$1<redacted>")
    .replace(
      /(\b(?:token|api[-_]?key|secret|password|passwd|pwd)\b\s*[=:]\s*)\S+/gi,
      "$1<redacted>",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+(@)/gi, "$1<redacted>$2");
}

export function listProcesses(platform: NodeJS.Platform): ReadonlyArray<ProcessInfo> | null {
  // No usable `ps` equivalent on Windows. Returning null (not an empty list)
  // keeps "could not look" distinguishable from "looked, found nothing".
  if (platform === "win32") return null;
  try {
    // `-ww` asks for the untruncated command line on both BSD and GNU `ps`.
    // Provider command lines are long and the `resume=` argument sits at the
    // end, so a width-truncated listing would silently match nothing.
    const output = NodeChildProcess.execFileSync(
      "ps",
      ["-Awwo", "pid=,ppid=,etime=,time=,command="],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const processes: ProcessInfo[] = [];
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const [, pid, ppid, elapsed, cpuTime, command] = match;
      if (!pid || !ppid || !elapsed || !cpuTime || command === undefined) continue;
      processes.push({ pid: Number(pid), ppid: Number(ppid), elapsed, cpuTime, command });
    }
    return processes;
  } catch {
    return null;
  }
}

export interface ProbeOptions {
  readonly platform: NodeJS.Platform;
  /** Hoisted by the caller so one `ps` covers every thread in a sweep. */
  readonly processes?: ReadonlyArray<ProcessInfo> | null;
  readonly showAllChildren?: boolean;
}

const unsupportedProbe = (resumeId: string | null, reason: string): SessionProbe => ({
  outcome: "unsupported",
  unsupportedReason: reason,
  resumeId,
  providerPid: null,
  children: [],
  hiddenChildren: 0,
});

export function probeSession(resumeId: string | null, options: ProbeOptions): SessionProbe {
  if (resumeId === null) {
    return unsupportedProbe(
      resumeId,
      "the provider session is not addressable by process (Codex sessions carry no command-line id)",
    );
  }
  const processes =
    options.processes === undefined ? listProcesses(options.platform) : options.processes;
  if (processes === null) {
    return unsupportedProbe(resumeId, "`ps` is unavailable on this host");
  }

  // Anchored on both sides: a bare substring match lets `resume=abc` accept an
  // unrelated `note=resume=abcdef`, which would report orphaned work as live.
  const resumeArgument = new RegExp(`(?:^|[\\s=])resume=${escapeRegExp(resumeId)}(?=$|\\s)`);
  const provider = processes.find((candidate) => resumeArgument.test(candidate.command));
  if (!provider) {
    return {
      outcome: "not-running",
      unsupportedReason: null,
      resumeId,
      providerPid: null,
      children: [],
      hiddenChildren: 0,
    };
  }

  const byParent = new Map<number, ProcessInfo[]>();
  for (const candidate of processes) {
    const siblings = byParent.get(candidate.ppid);
    if (siblings) siblings.push(candidate);
    else byParent.set(candidate.ppid, [candidate]);
  }

  // This script runs from a T3 terminal, which is itself a descendant of the
  // provider session it is probing. Reporting our own process tree as the
  // stuck work would be the tool's most embarrassing false positive.
  const self = new Set<number>();
  for (let pid: number | undefined = NodeProcess.pid; pid !== undefined && pid !== 0; ) {
    self.add(pid);
    pid = processes.find((candidate) => candidate.pid === pid)?.ppid;
    if (pid !== undefined && self.has(pid)) break;
  }

  const children: ProcessInfo[] = [];
  let hiddenChildren = 0;
  const walk = (pid: number) => {
    for (const child of byParent.get(pid) ?? []) {
      if (self.has(child.pid)) {
        hiddenChildren += 1;
      } else if (!options.showAllChildren && MCP_CHILD_PATTERN.test(child.command)) {
        hiddenChildren += 1;
      } else {
        children.push({ ...child, command: redactCommand(child.command) });
      }
      walk(child.pid);
    }
  };
  walk(provider.pid);
  return {
    outcome: "found",
    unsupportedReason: null,
    resumeId,
    providerPid: provider.pid,
    children,
    hiddenChildren,
  };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

const VERDICT_HEADLINE: Record<ThreadReport["verdict"], string> = {
  live: "LIVE",
  orphaned: "ORPHANED",
  unknown: "UNKNOWN",
  idle: "IDLE",
};

/** The probe decides; replay alone never gets the last word. */
export function verdictFor(
  liveness: ThreadBackgroundLiveness,
  session: SessionProbe | null,
): ThreadReport["verdict"] {
  if (liveness === null) return "idle";
  if (session === null) return "unknown";
  switch (session.outcome) {
    case "found":
      return "live";
    case "not-running":
      return "orphaned";
    case "unsupported":
      return "unknown";
  }
}

export function formatReports(reports: ReadonlyArray<ThreadReport>): string {
  const interesting = reports.filter((report) => report.verdict !== "idle");
  if (interesting.length === 0) {
    return "No live background work.";
  }

  const lines: string[] = [];
  for (const report of interesting) {
    const liveness = report.liveness ?? "none";
    lines.push(`${VERDICT_HEADLINE[report.verdict]} (${liveness})  ${report.title}`);
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
    if (session === null) {
      lines.push("  no process probe was run");
    } else if (session.outcome === "unsupported") {
      lines.push(`  cannot tell whether this is still running: ${session.unsupportedReason}`);
    } else if (session.outcome === "not-running") {
      lines.push(
        `  provider session ${session.resumeId} is not running — these tasks are stale bookkeeping, not live work`,
      );
    } else {
      const hidden =
        session.hiddenChildren === 0
          ? ""
          : ` (${session.hiddenChildren} hidden: MCP servers and this script; --show-all-children to include)`;
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
  readonly showAllChildren?: boolean;
}

export const runThreadBackground = Effect.fn("runThreadBackground")(function* (
  input: RunThreadBackgroundInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  // Every T3 terminal exports its thread id and the state directory of the
  // server that owns it, so a zero-argument run inspects the right database —
  // a thread id read against the wrong one reports nothing at all.
  //
  // T3CODE_STATE_DIR is preferred over T3CODE_HOME because the state directory
  // is not always `<home>/userdata`: a dev server uses `<home>/dev`, so
  // reconstructing the path would send a dev terminal at production state.
  const stateDir =
    input.baseDir !== undefined
      ? path.join(path.resolve(input.baseDir), "userdata")
      : (environment.T3CODE_STATE_DIR?.trim() ??
        path.join(
          path.resolve(environment.T3CODE_HOME?.trim() || path.join(NodeOS.homedir(), ".t3")),
          "userdata",
        ));
  const databasePath = path.join(path.resolve(stateDir), "state.sqlite");

  const threadId = (input.threadId ?? environment.T3CODE_THREAD_ID)?.trim() || undefined;

  if (!input.all && threadId === undefined) {
    return yield* new ThreadBackgroundMissingThreadError();
  }
  if (!(yield* fs.exists(databasePath))) {
    return yield* new ThreadBackgroundDatabaseMissingError({ databasePath });
  }

  const readReports = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Ordered exactly like ProjectionThreadActivityRepository.list: `sequence`
    // is the authoritative order and `created_at` ties on rows derived from one
    // provider event, so ordering by timestamp alone would replay siblings in
    // an arbitrary order.
    const activityRows = input.all
      ? yield* sql<TaskActivityRow>`
          select thread_id, kind, created_at, payload_json
          from projection_thread_activities
          where kind like 'task.%'
          order by
            case when sequence is null then 0 else 1 end asc,
            sequence asc,
            created_at asc,
            activity_id asc`
      : yield* sql<TaskActivityRow>`
          select thread_id, kind, created_at, payload_json
          from projection_thread_activities
          where thread_id = ${threadId ?? ""} and kind like 'task.%'
          order by
            case when sequence is null then 0 else 1 end asc,
            sequence asc,
            created_at asc,
            activity_id asc`;

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

    // One `ps` for the whole sweep: forking it per thread would be slow and
    // would compare threads against different snapshots of the process table.
    const anyLive = threadIds.some((id) => tasks.some((task) => task.threadId === id));
    const processes = anyLive ? listProcesses(platform) : [];

    return threadIds.map((id): ThreadReport => {
      const threadTasks = tasks.filter((task) => task.threadId === id);
      const liveness = foldLiveness(threadTasks);
      const session =
        liveness === null
          ? null
          : probeSession(resumeIdFromCursor(cursors.get(id) ?? null), {
              platform,
              processes,
              ...(input.showAllChildren === undefined
                ? {}
                : { showAllChildren: input.showAllChildren }),
            });
      return {
        threadId: id,
        title: titles.get(id) ?? "(unknown thread)",
        liveness,
        verdict: verdictFor(liveness, session),
        tasks: threadTasks,
        session,
      };
    });
  });

  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 5000").unprepared;
    // The reads must agree with each other: pairing an activity snapshot with a
    // newer provider cursor would let a task that has since ended look verified
    // by a freshly started session. One transaction gives them a single
    // consistent view of the database.
    return yield* sql.withTransaction(readReports);
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
    showAllChildren: Flag.boolean("show-all-children").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Include child processes hidden by the MCP-server filter."),
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Emit the report as JSON."),
    ),
  },
  ({ thread, baseDir, all, json, showAllChildren }) =>
    runThreadBackground({
      baseDir: Option.getOrUndefined(baseDir),
      threadId: Option.getOrUndefined(thread),
      all,
      showAllChildren,
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
