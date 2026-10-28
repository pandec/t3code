import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { resolveT3McpToolId } from "./t3McpToolPresentation.ts";

const BACKGROUND_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

// Plans and text streams can stay open across tool calls without executing work.
const EXECUTION_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  ...BACKGROUND_TURN_ITEM_TYPES,
  "file_change",
  "file_search",
  "web_search",
  "compaction",
]);

const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "rolled_back",
]);

// waiting is completed work awaiting checkpoints; exclude rolled_back entirely because provider threads are not run-tied.
const SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "waiting",
]);

void TERMINAL_RUN_STATUSES;

export type PendingBackgroundWorkTask = OrchestrationV2PendingBackgroundTask;

export function turnItemUpdateCanEndBackgroundWork(
  item: Pick<OrchestrationV2TurnItem, "type" | "status">,
): boolean {
  return BACKGROUND_TURN_ITEM_TYPES.has(item.type) && !isOrchestrationV2WorkActive(item.status);
}

export function deriveBlockedOnThreadWait(input: {
  readonly activeRun: Pick<OrchestrationV2Run, "id" | "status"> | null;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): boolean {
  if (input.activeRun?.status !== "running") return false;
  let hasWait = false;
  for (const item of input.turnItems) {
    if (
      item.runId !== input.activeRun.id ||
      !EXECUTION_TURN_ITEM_TYPES.has(item.type) ||
      (item.status !== "running" && item.status !== "waiting") ||
      // App-owned rows track the child, including the child a blocking delegate is waiting for.
      (item.type === "subagent" && item.origin === "app_owned")
    ) {
      continue;
    }
    if (item.type !== "dynamic_tool") return false;
    const tool = resolveT3McpToolId(item.toolName);
    if (
      tool !== "t3_thread_wait" &&
      !(
        tool === "delegate_task" &&
        Predicate.isObject(item.input) &&
        Reflect.get(item.input, "mode") === "wait"
      )
    ) {
      return false;
    }
    hasWait = true;
  }
  return hasWait;
}

export function backgroundWorkHoldsCompletion(
  tasks: ReadonlyArray<Pick<PendingBackgroundWorkTask, "kind" | "awaited">>,
): boolean {
  return tasks.some(
    (task) => task.awaited === true || backgroundWorkKindHoldsCompletion(task.kind),
  );
}

// Commands and monitors are as often a dev server or its watchdog as a wait, so they hold
// only when the agent marks them awaited.
function backgroundWorkKindHoldsCompletion(kind: PendingBackgroundWorkTask["kind"]): boolean {
  switch (kind) {
    case "command":
    case "monitor":
      return false;
    case "subagent":
    case "background_task":
      return true;
  }
}

type PendingBackgroundWorkRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status">;

type PendingBackgroundWorkPullRequest = Pick<
  ThreadPullRequestLink,
  "host" | "repository" | "number" | "url" | "source" | "watch"
>;

type PendingBackgroundWorkProviderThread = Pick<
  OrchestrationV2ProviderThread,
  "id" | "pendingBackgroundTasks"
> & { readonly providerInstanceId?: OrchestrationV2ProviderThread["providerInstanceId"] };

type PendingBackgroundWorkTurnItem = {
  readonly id: OrchestrationV2TurnItem["id"] | string;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly title: string | null;
  /** Shell readers join the owner, even when its provider thread belongs to a child app thread. */
  readonly owningProviderInstanceId?: OrchestrationV2ProviderThread["providerInstanceId"];
  readonly runId?: OrchestrationV2Run["id"] | string | null;
  readonly nativeItemRef?: {
    readonly nativeId: string | null;
  } | null;
  readonly input?: unknown;
  readonly monitor?: boolean | undefined;
  readonly prompt?: string | undefined;
  readonly childThreadId?: ThreadId | null;
};

function isLatestRunSettledForBackgroundWait(
  latestRun: PendingBackgroundWorkRun | null | undefined,
): boolean {
  if (latestRun === undefined || latestRun === null) {
    return false;
  }
  return SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES.has(latestRun.status);
}

function isPersistentDynamicToolInput(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return Reflect.get(input, "persistent") === true;
}

function descriptionFromTurnItem(item: PendingBackgroundWorkTurnItem): string | undefined {
  if (typeof item.title === "string" && item.title.trim().length > 0) {
    return item.title.trim();
  }
  if (item.type === "command_execution" && typeof item.input === "string") {
    const command = item.input.trim();
    return command.length > 0 ? command : undefined;
  }
  if (item.type === "dynamic_tool") {
    const toolName = Reflect.get(item, "toolName");
    if (typeof toolName === "string" && toolName.trim().length > 0) {
      return toolName.trim();
    }
  }
  if (item.type === "subagent" && typeof item.prompt === "string") {
    const prompt = item.prompt.trim();
    return prompt.length > 0 ? prompt : undefined;
  }
  return undefined;
}

function pendingTaskFromTurnItem(
  taskId: string,
  item: PendingBackgroundWorkTurnItem,
): PendingBackgroundWorkTask {
  const description = descriptionFromTurnItem(item);
  const named = { taskId, ...(description === undefined ? {} : { description }) };
  switch (item.type) {
    case "subagent":
      return {
        ...named,
        kind: "subagent",
        ...(item.owningProviderInstanceId === undefined
          ? {}
          : { providerInstanceId: item.owningProviderInstanceId }),
        ...(item.childThreadId == null ? {} : { childThreadId: item.childThreadId }),
      };
    case "command_execution":
      return { ...named, kind: item.monitor === true ? "monitor" : "command" };
    default:
      return { ...named, kind: "background_task" };
  }
}

function nativeTaskIdFromTurnItem(item: PendingBackgroundWorkTurnItem): string {
  const nativeId = item.nativeItemRef?.nativeId;
  if (typeof nativeId === "string" && nativeId.length > 0) {
    return nativeId;
  }
  return String(item.id);
}

/** Items Stop ends, without the pending list's settled-run gate. */
export function pendingBackgroundTurnItems<Item extends PendingBackgroundWorkTurnItem>(input: {
  readonly turnItems: ReadonlyArray<Item>;
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
}): ReadonlyArray<Item> {
  const rolledBackRunIds = new Set(
    (input.runs ?? []).filter((run) => run.status === "rolled_back").map((run) => String(run.id)),
  );
  return input.turnItems.filter(
    (item) =>
      BACKGROUND_TURN_ITEM_TYPES.has(item.type) &&
      isOrchestrationV2WorkActive(item.status) &&
      !(item.type === "dynamic_tool" && isPersistentDynamicToolInput(item.input)) &&
      (item.runId === undefined ||
        item.runId === null ||
        !rolledBackRunIds.has(String(item.runId))),
  );
}

export function derivePendingBackgroundWork(input: {
  readonly latestRun: PendingBackgroundWorkRun | null | undefined;
  readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
  readonly turnItems: ReadonlyArray<PendingBackgroundWorkTurnItem>;
  readonly activeProviderThreadId?: string | null;
  readonly hasActiveRun?: boolean;
  /** Excludes rolled-back runs; optional only when the caller already filtered them, as SQL shell reads do. */
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
  readonly pullRequests?: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined;
}): ReadonlyArray<PendingBackgroundWorkTask> {
  const hasActiveRun =
    input.hasActiveRun ??
    input.runs?.some(
      (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
    ) ??
    false;
  if (hasActiveRun) {
    return [];
  }
  if (input.latestRun == null) {
    return pullRequestWatchTasks(input.pullRequests);
  }
  if (!isLatestRunSettledForBackgroundWait(input.latestRun)) {
    return [];
  }

  const byTaskId = new Map<string, PendingBackgroundWorkTask>();

  const providerThreads =
    input.activeProviderThreadId === undefined || input.activeProviderThreadId === null
      ? input.providerThreads
      : input.providerThreads.filter((thread) => thread.id === input.activeProviderThreadId);

  for (const providerThread of providerThreads) {
    for (const task of providerThread.pendingBackgroundTasks ?? []) {
      if (task.taskId.length === 0 || byTaskId.has(task.taskId)) {
        continue;
      }
      const { description: rawDescription, ...named } = task;
      const description = rawDescription?.trim();
      byTaskId.set(task.taskId, {
        ...named,
        ...(task.kind === "subagent"
          ? { providerInstanceId: providerThread.providerInstanceId }
          : {}),
        ...(description === undefined || description.length === 0 ? {} : { description }),
      });
    }
  }

  for (const item of pendingBackgroundTurnItems(input)) {
    const taskId = nativeTaskIdFromTurnItem(item);
    if (byTaskId.has(taskId)) {
      continue;
    }

    byTaskId.set(taskId, pendingTaskFromTurnItem(taskId, item));
  }

  for (const task of pullRequestWatchTasks(input.pullRequests)) byTaskId.set(task.taskId, task);

  return Array.from(byTaskId.values());
}

/**
 * Fork: whether background work keeps an "until it's done" snooze asleep.
 * Only agent work counts (subagents and opaque background tasks such as
 * workflows). Commands and monitors are watch loops: a dev server or a
 * Monitor can outlive the work, so they never hold the snooze.
 */
function backgroundWorkKeepsSnoozeUntilDone(
  tasks: ReadonlyArray<{ readonly kind: string }>,
): boolean {
  return tasks.some(isAgentBackgroundWork);
}

/**
 * Fork: whether pending work is agent work (a subagent, or an opaque
 * background task such as a workflow) rather than a watch loop (a command
 * such as a dev server, or a monitor). Unknown kinds decode as
 * background_task, so they count as agent work.
 */
function isAgentBackgroundWork(task: { readonly kind: string }): boolean {
  return task.kind === "subagent" || task.kind === "background_task";
}

/**
 * Fork: how work left running after the turn presents. Live agents read as
 * Working; watch loops alone read as Monitoring. Null when nothing is pending.
 */
export type BackgroundWorkLiveness = "working" | "monitoring";

export function backgroundWorkLiveness(
  tasks: ReadonlyArray<{ readonly kind: string }>,
): BackgroundWorkLiveness | null {
  if (tasks.length === 0) return null;
  return tasks.some(isAgentBackgroundWork) ? "working" : "monitoring";
}

/**
 * Fork: which pending work a drain waits for. "agents" waits for agent work and
 * ignores watch loops; "all" waits for every task, monitors (including pull
 * request watches) included.
 */
export type BackgroundWorkDrainScope = "agents" | "all";

export function backgroundWorkInDrainScope<Task extends { readonly kind: string }>(
  tasks: ReadonlyArray<Task>,
  scope: BackgroundWorkDrainScope,
): ReadonlyArray<Task> {
  return scope === "all" ? tasks : tasks.filter(isAgentBackgroundWork);
}

/** Fork: one read of a thread's background work against a drain scope. */
export interface BackgroundWorkDrainState<Task> {
  /** What clients show: Working for live agents, Monitoring for watch loops alone. */
  readonly liveness: BackgroundWorkLiveness | null;
  /** A run is queued, executing, or finalizing, so its roster has not settled yet. */
  readonly runActive: boolean;
  /** The pending background work the scope waits for. */
  readonly pendingTasks: ReadonlyArray<Task>;
  /** No active run and nothing pending in scope: the drain is over. */
  readonly drained: boolean;
}

/**
 * Fork: what a drain still waits on, read from a thread shell and the
 * thread's run records. The shell's status leaves out a queue held by Stop,
 * so `runs` supplies queued runs independently of it.
 */
export function backgroundWorkDrainState<Task extends { readonly kind: string }>(
  shell: {
    readonly activeRunId: string | null;
    readonly activityRunStatus?: string | null | undefined;
    readonly status: string;
    readonly pendingBackgroundTasks?: ReadonlyArray<Task> | undefined;
  },
  scope: BackgroundWorkDrainScope,
  runs: ReadonlyArray<{ readonly status: string }>,
): BackgroundWorkDrainState<Task> {
  const tasks = shell.pendingBackgroundTasks ?? [];
  const pendingTasks = backgroundWorkInDrainScope(tasks, scope);
  // The roster stays empty while a run is live, so a live or queued run
  // (a wake continuing the work, or a held queue) keeps the drain open on its own.
  const runActive =
    shell.activeRunId !== null ||
    (shell.activityRunStatus ?? null) !== null ||
    shell.status === "queued" ||
    runs.some((run) => run.status === "queued");
  return {
    liveness: backgroundWorkLiveness(tasks),
    runActive,
    pendingTasks,
    drained: !runActive && pendingTasks.length === 0,
  };
}

const UNTIL_DONE_LIVE_RUN_STATUSES: ReadonlySet<string> = new Set<OrchestrationV2Run["status"]>([
  "queued",
  "preparing",
  "starting",
  "running",
]);

/**
 * Fork: whether an "until it's done" snooze's work continues: queued messages remain, the awaited
 * run is still latest and live ("waiting" is post-terminal drain), or it ended with agent
 * background work still running. The latest run moving elsewhere (replaced) or a failure ends it.
 */
export function snoozeUntilDoneWorkContinues(input: {
  readonly snoozedUntilRunId: string | null | undefined;
  readonly latestRunId: string | null | undefined;
  readonly latestRunStatus: string | null | undefined;
  readonly pendingBackgroundTasks: ReadonlyArray<{ readonly kind: string }>;
}): boolean {
  if (input.snoozedUntilRunId == null) return false;
  // A queued latest run means queued messages still wait to run, whichever
  // one the snooze last followed: the server moves it onto each run that
  // starts from the queue.
  if (input.latestRunStatus === "queued") return true;
  if (input.latestRunId !== input.snoozedUntilRunId) return false;
  if (input.latestRunStatus == null || input.latestRunStatus === "failed") return false;
  return (
    UNTIL_DONE_LIVE_RUN_STATUSES.has(input.latestRunStatus) ||
    backgroundWorkKeepsSnoozeUntilDone(input.pendingBackgroundTasks)
  );
}

function pullRequestWatchTasks(
  pullRequests: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined,
): Array<PendingBackgroundWorkTask> {
  return (pullRequests ?? []).flatMap((link) =>
    // Fork: a merged PR's watch still holds; PullRequestWatchReactor clears it and wakes the agent.
    link.watch === undefined || link.source === "stack-dismissed"
      ? []
      : [
          {
            // Links store their normalized identity, and this id only has to be unique within the
            // thread, so it reads those fields instead of parsing the URL.
            taskId: `pull-request-watch:${link.host.toLowerCase()}/${link.repository.toLowerCase()}#${link.number}`,
            description: `Watching pull request #${link.number}`,
            kind: "monitor" as const,
            awaited: true as const,
          },
        ],
  );
}
