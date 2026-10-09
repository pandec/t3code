import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";

import { threadPullRequestKeyOf } from "./threadPullRequests.ts";

const BACKGROUND_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

/**
 * True terminal run statuses (includes `rolled_back`). Retained as the
 * canonical terminal set for this module; do not widen or reuse it as the
 * background-wait gate — that gate intentionally excludes `rolled_back`.
 */
const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "rolled_back",
]);

/**
 * Run statuses that allow a pending-background roster to surface.
 * Includes `waiting`: a successful turn persists as waiting until checkpoint
 * capture flips it to completed, and waiting is only set from completed.
 * Excludes `rolled_back`: the provider-thread roster is not run-tied, so a
 * rolled-back latest run must fail the gate entirely (not only item filter).
 * Built explicitly rather than spreading or deleting from TERMINAL_RUN_STATUSES.
 */
const SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "waiting",
]);

// Keep TERMINAL_RUN_STATUSES referenced so the true-terminal set stays defined
// next to the background-wait subset (rolled_back is terminal, not wait-settled).
void TERMINAL_RUN_STATUSES;

export type PendingBackgroundWorkTask = OrchestrationV2PendingBackgroundTask;

/**
 * Whether a turn-item update can end background work that a settled run is
 * still waiting on: an item of a background type that is no longer active.
 * Streaming output on a running item, and every other item type, cannot.
 */
export function turnItemUpdateCanEndBackgroundWork(
  item: Pick<OrchestrationV2TurnItem, "type" | "status">,
): boolean {
  return BACKGROUND_TURN_ITEM_TYPES.has(item.type) && !isOrchestrationV2WorkActive(item.status);
}

/**
 * Whether background work left behind by a completed root run holds back its
 * completion alert (desktop/web notification and the mobile push). Commands,
 * such as dev servers and other long-lived shells, do not: the agent is done
 * and may leave them running for hours. Subagents and monitors do, because
 * they wake the agent and it continues (#13625). Work the adapter cannot name,
 * including kinds this build does not know, holds as the conservative choice.
 */
export function backgroundWorkHoldsCompletion(
  tasks: ReadonlyArray<Pick<PendingBackgroundWorkTask, "kind">>,
): boolean {
  return tasks.some((task) => backgroundWorkKindHoldsCompletion(task.kind));
}

function backgroundWorkKindHoldsCompletion(kind: PendingBackgroundWorkTask["kind"]): boolean {
  switch (kind) {
    case "command":
      return false;
    case "subagent":
    case "monitor":
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
>;

type PendingBackgroundWorkTurnItem = {
  readonly id: OrchestrationV2TurnItem["id"] | string;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly title: string | null;
  /** When present and the run is rolled_back, the item is abandoned, not pending. */
  readonly runId?: OrchestrationV2Run["id"] | string | null;
  readonly nativeItemRef?: {
    readonly nativeId: string | null;
  } | null;
  readonly input?: unknown;
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
        ...(item.childThreadId == null ? {} : { childThreadId: item.childThreadId }),
      };
    case "command_execution":
      return { ...named, kind: "command" };
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

/**
 * The turn items the pending-work list names, without its settled-run gate.
 * Stop ends exactly these, so the list and Stop cannot disagree.
 */
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
      // Null/absent run id stays eligible; only known rolled_back runs drop.
      (item.runId === undefined ||
        item.runId === null ||
        !rolledBackRunIds.has(String(item.runId))),
  );
}

/**
 * Derive one normalized pending-background-work list for post-settlement UI.
 *
 * Sources:
 * - Provider-thread roster (Claude SDK background tasks)
 * - Active command_execution / dynamic_tool / subagent turn items
 * - Pull request watches, as monitors: a watch wakes the agent, so the thread
 *   stays working between wakes instead of returning to the inbox. Callers
 *   that pick a run to interrupt leave `pullRequests` out; Stop ends watches
 *   on its own.
 *
 * Gated on latest root run settlement. Dedupes by native task ID. Excludes
 * the roster while any interruptible foreground run remains active. Excludes
 * Grok persistent monitors (`dynamic_tool` input with `persistent: true`).
 * Excludes turn items whose run resolves to `rolled_back` (abandoned work);
 * items with a null or absent run id stay eligible (matches SQL shell path).
 * Does not consult subagent entities (those double-count turn items).
 */
export function derivePendingBackgroundWork(input: {
  readonly latestRun: PendingBackgroundWorkRun | null | undefined;
  readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
  readonly turnItems: ReadonlyArray<PendingBackgroundWorkTurnItem>;
  readonly activeProviderThreadId?: string | null;
  readonly hasActiveRun?: boolean;
  /**
   * Run rows used to exclude items owned by rolled_back runs. Optional for
   * callers that already filtered (SQL shell path); in-memory callers should
   * pass projection runs so policy cannot drift.
   */
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
  // A thread that never ran waits on nothing else, but a watch started on it still wakes it.
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
export function backgroundWorkKeepsSnoozeUntilDone(
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
export function isAgentBackgroundWork(task: { readonly kind: string }): boolean {
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
 * Fork: liveness as thread rows show it. A command left running (a dev server)
 * does not hold the thread, matching `backgroundWorkHoldsCompletion`, so a
 * command-only roster reads as done. The CLI keeps the raw
 * `backgroundWorkLiveness` so automation still sees those commands.
 */
export function backgroundWorkDisplayLiveness(
  tasks: ReadonlyArray<{ readonly kind: string }>,
): BackgroundWorkLiveness | null {
  return backgroundWorkLiveness(tasks.filter((task) => task.kind !== "command"));
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
 * Fork: whether the work an "until it's done" snooze waits on continues: the
 * awaited run is still the latest one and is live (a run parked at
 * "waiting" is post-terminal drain, so its agent turn is over), or it ended
 * while its agent background work runs on. A wake run that continues the work takes
 * over as the awaited run on the server, so the latest run moving elsewhere
 * means the work was replaced. A failure always ends it. Shared by the
 * server (validation, settlement) and clients (snoozed classification).
 */
export function snoozeUntilDoneWorkContinues(input: {
  readonly snoozedUntilRunId: string | null | undefined;
  readonly latestRunId: string | null | undefined;
  readonly latestRunStatus: string | null | undefined;
  readonly pendingBackgroundTasks: ReadonlyArray<{ readonly kind: string }>;
}): boolean {
  if (input.snoozedUntilRunId == null || input.latestRunId !== input.snoozedUntilRunId) {
    return false;
  }
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
    link.watch === undefined || link.source === "stack-dismissed"
      ? []
      : [
          {
            taskId: `pull-request-watch:${threadPullRequestKeyOf(link)}`,
            description: `Watching pull request #${link.number}`,
            kind: "monitor" as const,
          },
        ],
  );
}
