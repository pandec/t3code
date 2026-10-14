import {
  isLabStackStopped,
  type LabEnvironment,
  type LabInventoryEntry,
  type LabReleaseBlocker,
  type LabT3Operation,
  type LabT3State,
  type LabsSnapshot,
} from "@t3tools/contracts";

import type { DraftLabIntent } from "../../composerDraftStore";

/** Fork: SP Labs view logic shared by the Labs panel, header chip and Lab-mode composer. */

export type LabAvailability = "free" | "held" | "reserved" | "unavailable";

/** A reservation wins over a hold; a lab that is neither and not ready is unavailable. */
export function resolveLabAvailability(environment: LabEnvironment): LabAvailability {
  if (environment.lease !== null) return "reserved";
  if (environment.hold !== null) return "held";
  return environment.available === true ? "free" : "unavailable";
}

const trimTrailingSlashes = (path: string) => path.replace(/[/\\]+$/, "");

/**
 * The lab a thread works in: the one whose worktree is the thread's, or the one its lease names
 * (an agent that acquired a lab itself keeps its own T3 worktree).
 */
export function findLabForThread<
  T extends Pick<LabInventoryEntry, "kind" | "worktree" | "ownerThreadId">,
>(
  environments: ReadonlyArray<T>,
  thread: { readonly threadId: string; readonly worktreePath: string | null | undefined },
): T | null {
  const target = thread.worktreePath ? trimTrailingSlashes(thread.worktreePath) : null;
  const labs = environments.filter((environment) => environment.kind === "lab");
  return (
    labs.find(
      (environment) => target !== null && trimTrailingSlashes(environment.worktree) === target,
    ) ??
    labs.find((environment) => environment.ownerThreadId === thread.threadId) ??
    null
  );
}

/** "Default to Lab mode" applies only to new drafts in the resolved labs project. */
export function shouldDefaultToLabMode(input: {
  readonly defaultToLabMode: boolean;
  readonly labsProjectId: string | null;
  readonly projectId: string | null;
}): boolean {
  return (
    input.defaultToLabMode &&
    input.labsProjectId !== null &&
    input.labsProjectId === input.projectId
  );
}

export type LabHealthTone = "ok" | "warn" | "error" | "off" | "busy";

export interface LabStackHealth {
  readonly tone: LabHealthTone;
  readonly label: string;
}

const T3_OPERATION_LABELS: Record<LabT3Operation, string> = {
  acquiring: "Reserving",
  starting: "Starting",
  stopping: "Stopping",
  reloading: "Reloading",
  releasing: "Releasing",
  "opening-browser": "Opening browser",
  "opening-sidepanel": "Opening side panel",
  "updating-hold": "Updating hold",
};

export function labOperationLabel(operation: LabT3Operation): string {
  return T3_OPERATION_LABELS[operation];
}

/**
 * One summary of a lab's stack: a running command first, then a failed `up` while the
 * stack is not fully up, then the passive health.
 */
export function resolveLabStackHealth(
  environment: Pick<LabEnvironment, "kind" | "runtime">,
  t3: LabT3State | undefined,
): LabStackHealth {
  if (t3?.operation) return { tone: "busy", label: labOperationLabel(t3.operation) };
  const { runtime } = environment;
  if (runtime.operation !== null) {
    return { tone: "busy", label: `Running ${runtime.operation.command}` };
  }
  const chromeUp = runtime.chrome.state === "up";
  const backendReady = runtime.backend.state === "ready";
  // Preview and staging have no WXT dev server.
  const wxtUp = environment.kind !== "lab" || runtime.wxt.state === "up";
  const fullyUp = chromeUp && wxtUp && backendReady;
  if (t3?.lastUp && !t3.lastUp.ok && !fullyUp) return { tone: "error", label: "Start failed" };
  if (runtime.backend.state === "error") return { tone: "error", label: "Backend error" };
  if (fullyUp) return { tone: "ok", label: "Running" };
  if (!isLabStackRunning(environment)) return { tone: "off", label: "Stopped" };
  return { tone: "warn", label: "Partly running" };
}

/** Main/Staging and Preview run no stack of their own; their browser is all there is to stop. */
export function isLabStackRunning(environment: Pick<LabEnvironment, "kind" | "runtime">): boolean {
  return environment.kind === "lab"
    ? !isLabStackStopped(environment.runtime)
    : environment.runtime.chrome.state !== "down";
}

const RELEASE_BLOCKER_LABELS: Record<LabReleaseBlocker["kind"], string> = {
  not_reserved: "Not reserved",
  dirty_worktree: "Uncommitted changes",
  stack_running: "Stack is running",
  operation_running: "A command is running",
};

export function describeReleaseBlocker(blocker: LabReleaseBlocker): string {
  const label = RELEASE_BLOCKER_LABELS[blocker.kind];
  return blocker.detail.trim().length > 0 ? `${label}: ${blocker.detail}` : label;
}

/** Stopping first resolves the release only when a running stack is the sole blocker. */
export function releaseCanStopFirst(blockers: ReadonlyArray<LabReleaseBlocker>): boolean {
  return blockers.length > 0 && blockers.every((blocker) => blocker.kind === "stack_running");
}

/** The visible message "Ask agent to wrap up & release" sends to the lab's owner thread. */
export function buildLabWrapUpMessage(labId: string): string {
  return [
    `Please wrap up your work in ${labId} and release it:`,
    "commit everything worth keeping,",
    `stop the stack with \`sp-labs down ${labId}\`,`,
    `then \`sp-labs release ${labId}\`.`,
    "Pass --handoff only if you leave surprising state behind (data, config, or a broken stack).",
  ].join(" ");
}

export type LabBranchRequest =
  | { readonly ok: true; readonly branch: string | null; readonly baseRef: string | null }
  | { readonly ok: false; readonly error: string };

/** What `prepareThread` gets for a draft's branch choice. */
export function resolveLabBranchRequest(intent: DraftLabIntent): LabBranchRequest {
  const branch = intent.branchName.trim();
  if (intent.branchMode === "continue") {
    return branch.length === 0
      ? { ok: false, error: "Choose the branch to continue in the lab." }
      : { ok: true, branch, baseRef: null };
  }
  const baseRef = intent.baseRef.trim();
  return { ok: true, branch: branch.length === 0 ? null : branch, baseRef: baseRef || "master" };
}

export type LabSendTarget =
  | { readonly ok: true; readonly labId: string }
  | { readonly ok: false; readonly error: string };

/**
 * The lab a first send reserves: the draft's pick, else the first free lab. A pick that has
 * since been reserved by another thread or held fails here rather than in the CLI.
 */
export function resolveLabSendTarget(
  intent: DraftLabIntent,
  snapshot: Pick<LabsSnapshot, "environments"> | null,
  threadId: string,
): LabSendTarget {
  const labs = snapshot?.environments.filter((environment) => environment.kind === "lab") ?? [];
  // A retried send finds its lab already reserved for this thread.
  const ownLab = labs.find((environment) => environment.lease?.threadId === threadId);
  if (ownLab) return { ok: true, labId: ownLab.id };
  if (intent.labId !== null) {
    const picked = labs.find((environment) => environment.id === intent.labId);
    if (picked?.lease) {
      return { ok: false, error: `${picked.name} is reserved. Pick a free lab.` };
    }
    if (picked?.hold) return { ok: false, error: `${picked.name} is held. Pick a free lab.` };
    return { ok: true, labId: intent.labId };
  }
  if (snapshot === null) return { ok: false, error: "Labs are still loading. Try again." };
  const free = labs.find((environment) => resolveLabAvailability(environment) === "free");
  return free
    ? { ok: true, labId: free.id }
    : { ok: false, error: "No lab is free. Release one in the Labs panel." };
}

/** The reservation purpose recorded in sp-labs: the first line of the first message. */
export function resolveLabPurpose(message: string, fallback: string): string {
  const firstLine = message.trim().split("\n", 1)[0]?.trim() ?? "";
  const purpose = firstLine.length > 0 ? firstLine : fallback.trim();
  return (purpose.length > 0 ? purpose : "T3 Code thread").slice(0, 200);
}
