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
  "opening-sidepanel": "Opening extension panel",
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

// ── Dashboard-style summaries (the sp-labs dashboard's phrasing) ─────────

/** A reservation whose owner went quiet this long counts as an idle hold. */
export const LAB_IDLE_HOLD_HOURS = 18;

const parseTime = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

/** "just now", "44 min ago", "3 h ago", "2 days ago"; "unknown" without a time. */
export function formatLabAgo(value: string | null | undefined, now: number): string {
  const time = parseTime(value);
  if (time === null) return "unknown";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} days ago`;
  return new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** What the panel knows about a lease's owner from T3's own thread shells. */
export interface LabOwnerView {
  readonly title: string;
  readonly working: boolean;
  readonly needsYou: boolean;
  readonly archived: boolean;
  readonly lastActivityAt: string | null;
}

/**
 * The tone drives the status word's color and the row tint: free (success), reserved (info),
 * attention (warning), bad (destructive), kept (a human hold), shared (Main/Staging, Preview).
 */
export type LabSummaryTone = "free" | "reserved" | "attention" | "bad" | "kept" | "shared";

/** A sentence part: text, or the owner thread rendered as a link. */
export type LabSummarySegment = string | { readonly owner: string };

export interface LabSummary {
  readonly word: string;
  readonly tone: LabSummaryTone;
  readonly sentence: ReadonlyArray<LabSummarySegment>;
  /** One muted line: the purpose of a reservation, the handoff of a free lab, a hold note. */
  readonly note: string | null;
  /** When the row's state started: last activity of a reservation, the release of a free lab. */
  readonly since: string | null;
  /** Counts toward "needs a look". */
  readonly needsLook: boolean;
}

/** The latest of the lab's journaled activity, the owner's own activity, and the reservation. */
function lastHoldActivity(environment: LabEnvironment, owner: LabOwnerView | null): string | null {
  const candidates = [
    environment.lastActivityAt,
    owner?.lastActivityAt ?? null,
    environment.lease?.acquiredAt ?? null,
  ];
  let latest: { value: string; time: number } | null = null;
  for (const value of candidates) {
    const time = parseTime(value);
    if (value && time !== null && (latest === null || time > latest.time)) latest = { value, time };
  }
  return latest?.value ?? null;
}

/** Reserved, its owner not working, and nothing happened for LAB_IDLE_HOLD_HOURS. */
export function isLabIdleHold(
  environment: LabEnvironment,
  owner: LabOwnerView | null,
  now: number,
): boolean {
  if (environment.lease === null || owner?.working === true) return false;
  const time = parseTime(lastHoldActivity(environment, owner));
  return time !== null && now - time >= LAB_IDLE_HOLD_HOURS * 3_600_000;
}

/** One word and one sentence per environment, in the dashboard's words. */
export function summarizeLabEnvironment(
  environment: LabEnvironment,
  owner: LabOwnerView | null,
  now: number,
): LabSummary {
  const runtime = environment.runtime;
  if (environment.kind !== "lab") {
    const chrome = runtime.chrome.state;
    const wxt = environment.kind === "preview" ? chrome : runtime.wxt.state;
    const base = { tone: "shared" as const, note: runtime.diagnosis[0] ?? null, since: null };
    if (chrome === "up" && wxt === "up") {
      const sentence =
        environment.kind === "preview" ? "Chrome is up." : "Chrome and the dev server are up.";
      return { ...base, word: "Running", sentence: [sentence], needsLook: false };
    }
    if (chrome === "down" && wxt === "down") {
      return { ...base, word: "Stopped", sentence: ["Nothing is running."], needsLook: false };
    }
    if (chrome === "unknown" || wxt === "unknown") {
      return {
        ...base,
        word: "Unknown",
        sentence: ["The last check could not tell."],
        needsLook: false,
      };
    }
    return {
      ...base,
      word: "Partial",
      sentence: [`Chrome is ${chrome}, dev server is ${wxt}.`],
      needsLook: false,
    };
  }
  if (environment.phase === "quarantined") {
    return {
      word: "Quarantined",
      tone: "bad",
      sentence: ["Held back until someone repairs it."],
      note: environment.handoff?.summary ?? null,
      since: environment.handoff?.releasedAt ?? null,
      needsLook: true,
    };
  }
  if (environment.phase === "pending") {
    return {
      word: "Not provisioned",
      tone: "kept",
      sentence: ["Setup has not finished."],
      note: null,
      since: null,
      needsLook: false,
    };
  }
  const lease = environment.lease;
  if (lease) {
    const taken = formatLabAgo(lease.acquiredAt, now);
    const activity = lastHoldActivity(environment, owner);
    const base = { note: lease.purpose || null, since: activity };
    if (!owner) {
      return {
        ...base,
        word: "Reserved",
        tone: "attention",
        sentence: [
          lease.threadId
            ? `Reserved ${taken}, but the owner thread is not in T3.`
            : `Reserved ${taken} outside T3.`,
        ],
        needsLook: false,
      };
    }
    const link = { owner: owner.title };
    if (owner.archived) {
      return {
        ...base,
        word: "Reserved",
        tone: "bad",
        sentence: [link, " was archived but still holds this lab."],
        needsLook: true,
      };
    }
    if (owner.needsYou) {
      return {
        ...base,
        word: "Waiting for you",
        tone: "attention",
        sentence: [link, " is blocked on your input."],
        needsLook: true,
      };
    }
    if (isLabIdleHold(environment, owner, now)) {
      return {
        ...base,
        word: "Idle hold",
        tone: "attention",
        sentence: [link, ` finished ${formatLabAgo(activity, now)} but still holds the lab.`],
        needsLook: true,
      };
    }
    return {
      ...base,
      word: "Reserved",
      tone: "reserved",
      sentence: owner.working
        ? [link, ` is working right now, taken ${taken}.`]
        : [link, ` holds it, taken ${taken}.`],
      needsLook: false,
    };
  }
  if (environment.hold) {
    return {
      word: "Held",
      tone: "kept",
      sentence: [`Held for you ${formatLabAgo(environment.hold.heldAt, now)}; agents skip it.`],
      note: environment.hold.note || null,
      since: environment.hold.heldAt,
      needsLook: false,
    };
  }
  const handoff = environment.handoff;
  if (environment.available === true) {
    return {
      word: "Free",
      tone: "free",
      sentence: [
        handoff
          ? `Released ${formatLabAgo(handoff.releasedAt, now)}, left ${handoff.disposition === "usable" ? "usable" : "needing repair"}.`
          : "Never used.",
      ],
      note: handoff?.summary ?? null,
      since: handoff?.releasedAt ?? null,
      needsLook: handoff?.disposition === "needs-repair",
    };
  }
  return {
    word: "Unavailable",
    tone: "attention",
    sentence: ["Not reserved, but not free either."],
    note: null,
    since: null,
    needsLook: true,
  };
}

/** "3 of 5 labs free, 1 in use. sp-lab-2 needs a look." */
export function summarizeLabsHeadline(
  labs: ReadonlyArray<{ readonly name: string; readonly summary: LabSummary }>,
): { readonly text: string; readonly attention: string | null } {
  const free = labs.filter((lab) => lab.summary.word === "Free").length;
  const inUse = labs.filter((lab) => lab.summary.tone === "reserved").length;
  const text = `${free} of ${labs.length} labs free${inUse > 0 ? `, ${inUse} in use` : ""}.`;
  const look = labs.filter((lab) => lab.summary.needsLook);
  const attention =
    look.length === 1
      ? `${look[0]!.name} needs a look.`
      : look.length > 1
        ? `${look.length} need a look.`
        : null;
  return { text: attention ? text : `${text} Nothing needs you.`, attention };
}

export type LabCheckState = "ok" | "off" | "bad" | "unknown" | "na";

export interface LabCheck {
  readonly label: string;
  readonly short: string;
  readonly state: LabCheckState;
  readonly word: string;
  readonly detail: string;
}

/** Chrome, dev server, backend and extension, as the dashboard shows them. */
export function resolveLabChecks(
  environment: Pick<LabEnvironment, "kind" | "runtime">,
): LabCheck[] {
  const { runtime } = environment;
  const preview = environment.kind === "preview";
  const link = (state: string) =>
    state === "up"
      ? { state: "ok" as const, word: "Up" }
      : state === "down"
        ? { state: "off" as const, word: "Down" }
        : { state: "unknown" as const, word: "Unknown" };
  const na = { state: "na" as const, word: "Not applicable", detail: "" };
  return [
    { label: "Chrome", short: "Chr", ...link(runtime.chrome.state), detail: runtime.chrome.detail },
    preview
      ? { label: "Dev server", short: "WXT", ...na }
      : {
          label: "Dev server",
          short: "WXT",
          ...link(runtime.wxt.state),
          detail: runtime.wxt.detail,
        },
    preview
      ? { label: "Backend", short: "Bk", ...na }
      : {
          label: "Backend",
          short: "Bk",
          state:
            runtime.backend.state === "ready"
              ? "ok"
              : runtime.backend.state === "error"
                ? "bad"
                : "unknown",
          word:
            runtime.backend.state === "ready"
              ? "Ready"
              : runtime.backend.state === "error"
                ? "Error"
                : "Unknown",
          detail: runtime.backend.detail,
        },
    {
      label: "Extension",
      short: "Ext",
      state:
        runtime.extension.state === "verified"
          ? "ok"
          : runtime.extension.state === "mismatch"
            ? "bad"
            : "unknown",
      word:
        runtime.extension.state === "verified"
          ? "Verified"
          : runtime.extension.state === "mismatch"
            ? "Mismatch"
            : "Unverified",
      detail: runtime.extension.detail,
    },
  ];
}

/** The branch worth showing: the checkout's, or the handoff's when the checkout is detached. */
export function resolveLabBranch(environment: Pick<LabEnvironment, "runtime" | "handoff">): {
  readonly name: string;
  readonly commit: string;
  readonly fromHandoff: boolean;
  readonly dirty: boolean;
} {
  const git = environment.runtime.git;
  if (git && git.branch !== "Detached HEAD") {
    return { name: git.branch, commit: git.commit, fromHandoff: false, dirty: git.dirty };
  }
  if (environment.handoff?.branch) {
    return {
      name: environment.handoff.branch,
      commit: git?.commit ?? environment.handoff.commit,
      fromHandoff: true,
      dirty: git?.dirty ?? false,
    };
  }
  return git
    ? { name: git.branch, commit: git.commit, fromHandoff: false, dirty: git.dirty }
    : { name: "unknown", commit: "", fromHandoff: false, dirty: false };
}

/** Labs first in numeric order, then the shared checkouts. */
export function orderLabEnvironments<T extends Pick<LabEnvironment, "kind" | "name">>(
  environments: ReadonlyArray<T>,
): { readonly labs: T[]; readonly shared: T[] } {
  return {
    labs: environments
      .filter((environment) => environment.kind === "lab")
      .toSorted((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true })),
    shared: environments.filter((environment) => environment.kind !== "lab"),
  };
}
